package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"strings"
	"time"

	"errors"
	"github.com/jackc/pgx/v5"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	"github.com/xxww0098/podhub-go/internal/media/jobs/slicepurge"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	"github.com/xxww0098/podhub-go/internal/platform/r2"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func (s *Server) getWorkspaceSliceStorage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	actor, _, err := s.mediaActor(r, "")
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	var row *mediarepo.SliceStorage
	var clear *mediarepo.SliceClearRequest
	daily := "waiting"
	err = s.transitTx(r.Context(), actor, false, func(tx pgx.Tx) error {
		var err error
		row, err = mediarepo.ActiveSliceStorage(r.Context(), tx, actor.OrgID, s.SliceStorageKey)
		if err != nil || row == nil {
			return err
		}
		if row.ClearAtMinute != nil {
			now := s.now().In(media.Shanghai())
			boundary := time.Date(now.Year(), now.Month(), now.Day(), int(*row.ClearAtMinute)/60, int(*row.ClearAtMinute)%60, 0, 0, media.Shanghai())
			if !boundary.After(now) && !boundary.Before(row.ClearConfiguredAt) {
				daily = "unconfirmed"
			}
			var status, code string
			err = tx.QueryRow(r.Context(), `SELECT status,COALESCE(error_code,'') FROM public.transit_clear_runs
				WHERE bucket_identity=$1 AND run_day=(clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date AND boundary_at >= $2`, media.SliceClearIdentity("daily", row.Account.ID), row.ClearConfiguredAt).Scan(&status, &code)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			switch status {
			case "running":
				daily = "running"
			case "partial":
				if code == "slice_wait_uploads" {
					daily = "running"
				} else {
					daily = "retrying"
				}
			case "completed":
				daily = "completed"
			}
		}
		request, err := mediarepo.LatestSliceClear(r.Context(), tx, actor.OrgID, row.Account.ID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err == nil {
			clear = &request
		}
		return err
	})
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	connected := false
	if actor.WorkspaceRole == "owner" && s.cloudflareReady() {
		grant, err := s.readCloudflareGrant(r, actor, cloudflareTokenCookie)
		connected = err == nil && grant.Token != ""
	}
	if row == nil {
		var provision *mediarepo.SliceProvision
		err := s.transitTx(r.Context(), actor, false, func(tx pgx.Tx) error {
			var err error
			provision, err = mediarepo.ReadSliceProvision(r.Context(), tx, actor.OrgID)
			return err
		})
		if err != nil {
			writeMediaFailure(w, err)
			return
		}
		jsonwire.Write(w, http.StatusOK, map[string]any{"configured": false, "can_manage": actor.WorkspaceRole == "owner", "oauth_available": s.cloudflareReady(), "cloudflare_connected": connected, "provision": provision})
		return
	}
	status := "idle"
	if clear != nil && clear.FinishedAt != nil {
		status = "completed"
	} else if clear != nil && clear.ErrorCode != nil {
		status = "retrying"
	} else if clear != nil {
		status = "pending"
	}
	mode := "manual"
	var clearTime *string
	if row.ClearAtMinute != nil {
		mode = "daily"
		value := fmt.Sprintf("%02d:%02d", *row.ClearAtMinute/60, *row.ClearAtMinute%60)
		clearTime = &value
	}
	jsonwire.Write(w, http.StatusOK, map[string]any{"configured": true, "can_manage": actor.WorkspaceRole == "owner", "oauth_available": s.cloudflareReady(), "cloudflare_connected": connected, "delete_enabled": actor.WorkspaceRole == "owner" && s.SliceDeleteAllowed, "key_prefix": row.Account.KeyPrefix, "bucket": row.Account.Bucket, "public_base_url": row.Account.PublicBaseURL, "clear_status": status, "daily_clear_status": daily, "cleanup_mode": mode, "cleanup_time": clearTime})
}

func (s *Server) clearWorkspaceSliceStorage(w http.ResponseWriter, r *http.Request) {
	actor, _, err := s.mediaActor(r, "")
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	if actor.WorkspaceRole != "owner" {
		writeMediaFailure(w, workspaceStorageOwnerRequired())
		return
	}
	if !s.SliceDeleteAllowed {
		writeMediaFailure(w, &mediaFailure{503, "UNAVAILABLE", "切片清理服务未启用"})
		return
	}
	err = s.ownerStorageTx(r.Context(), actor, func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended('workspace-slice-storage:'||$1::bigint::text,0))`, actor.OrgID); err != nil {
			return err
		}
		row, err := mediarepo.ActiveSliceStorage(r.Context(), tx, actor.OrgID, s.SliceStorageKey)
		if err != nil {
			return err
		}
		if row == nil {
			return &mediaFailure{422, "VALIDATION", "请先配置切片 R2"}
		}
		_, err = mediarepo.RequestSliceClear(r.Context(), tx, actor.OrgID, actor.UserID, row.Account.ID)
		return err
	})
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	jsonwire.Write(w, http.StatusAccepted, map[string]any{"clear_status": "pending"})
}

// verifySliceStorage uses a unique slice key and requires public/private
// readback, listing, and an acknowledged exact-key delete before activation.
func verifySliceStorage(ctx context.Context, account sign.Account, workspace, browserOrigin string) (cleanupNeeded bool, err error) {
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		return false, err
	}
	sum := sha256.Sum256(data.Bytes())
	digest := hex.EncodeToString(sum[:])
	now := time.Now()
	batch := newTransitBatch(now.Add(-time.Minute))
	key, err := objectkey.ComposeBatchedKey(account.KeyPrefix, workspace, digest, "png", batch)
	if err != nil {
		return false, err
	}
	origin := slicepurge.AccountOrigin{Account: account, Before: now}
	grant, err := sign.SignPut(account, key, "image/png", uint64(data.Len()), now, digest, nil)
	if err != nil {
		return false, err
	}
	cleanupNeeded = true
	resp, err := r2.ExchangeAccount(ctx, account, r2.Request{Method: http.MethodPut, URL: grant.URL, Headers: map[string]string{"Content-Type": "image/png", "If-None-Match": "*", "X-Amz-Checksum-Sha256": grant.ChecksumSHA256}, Body: data.Bytes(), Timeout: 30 * time.Second, StrictRead: true})
	if err != nil || resp.Status != http.StatusOK {
		if err == nil && resp.Status >= 400 && resp.Status < 500 {
			cleanupNeeded = false
		}
		return cleanupNeeded, r2WriteFailed()
	}
	defer func() {
		if cleanupNeeded {
			cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			result, err := origin.Delete(cleanup, []string{key})
			if err == nil && result.Deleted == 1 && len(result.FailedKeys) == 0 {
				cleanupNeeded = false
			}
		}
	}()
	// The preflight is judged only after the signed PUT has proved bucket, endpoint
	// and token: R2 answers a preflight for a missing bucket with the same 403
	// "CORS not configured" as for a missing policy, so any earlier verdict would
	// send a mistyped bucket name to the CORS step. Return cleanupNeeded, never
	// false: the deferred delete must still remove the object written above.
	if browserOrigin != "" {
		preflight, err := r2.ExchangeAccount(ctx, account, r2.Request{Method: http.MethodOptions, URL: grant.URL, Headers: map[string]string{"Origin": browserOrigin, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type,if-none-match,x-amz-checksum-sha256"}, Timeout: 15 * time.Second, StrictRead: true})
		headers := http.Header(preflight.Header)
		if err != nil || (preflight.Status != 200 && preflight.Status != 204) || (headers.Get("Access-Control-Allow-Origin") != browserOrigin && headers.Get("Access-Control-Allow-Origin") != "*") || !headerHas(headers.Get("Access-Control-Allow-Methods"), "PUT") {
			return cleanupNeeded, r2CORSFailed()
		}
		allowed := strings.ToLower(headers.Get("Access-Control-Allow-Headers"))
		if !headerHas(allowed, "*") && (!headerHas(allowed, "content-type") || !headerHas(allowed, "if-none-match") || !headerHas(allowed, "x-amz-checksum-sha256")) {
			return cleanupNeeded, r2CORSFailed()
		}
	}
	lease := transitLease{key: key, digest: digest, extension: "png", bytes: int64(data.Len())}
	readbackURL, _, err := sign.PresignURL(account, http.MethodGet, key, "", now, 5*time.Minute, nil, nil)
	if err != nil {
		return cleanupNeeded, r2VerificationFailed()
	}
	contentType, _ := objectkey.ContentType(lease.extension)
	if _, _, err := verifyTransitObject(ctx, account, lease, readbackURL, contentType, true); err != nil {
		return cleanupNeeded, r2PermissionFailed()
	}
	if _, _, err := verifyTransitObject(ctx, account, lease, sign.PublicURL(account, key), contentType, false); err != nil {
		return cleanupNeeded, r2PublicAccessFailed()
	}
	if browserOrigin != "" {
		public, err := r2.ExchangeAccount(ctx, account, r2.Request{Method: http.MethodGet, URL: sign.PublicURL(account, key), Headers: map[string]string{"Origin": browserOrigin}, Timeout: 15 * time.Second, StrictRead: true, MaxBytes: int64(data.Len())})
		allowed := http.Header(public.Header).Get("Access-Control-Allow-Origin")
		if err != nil || public.Status != http.StatusOK || !bytes.Equal(public.Body, data.Bytes()) {
			return cleanupNeeded, r2PublicAccessFailed()
		}
		if allowed != browserOrigin && allowed != "*" {
			return cleanupNeeded, r2CORSFailed()
		}
	}
	keys, err := origin.List(ctx)
	if err != nil || len(keys) != 1 || keys[0] != key {
		return cleanupNeeded, r2PermissionFailed()
	}
	result, err := origin.Delete(ctx, keys)
	if err != nil || result.Deleted != 1 || len(result.FailedKeys) != 0 {
		return cleanupNeeded, r2PermissionFailed()
	}
	privateURL, _, err := sign.PresignURL(account, http.MethodGet, key, "", now, time.Minute, nil, nil)
	if err != nil {
		return cleanupNeeded, err
	}
	resp, err = r2.ExchangeAccount(ctx, account, r2.Request{Method: http.MethodGet, URL: privateURL, Timeout: 15 * time.Second, StrictRead: true})
	if err != nil || resp.Status != http.StatusNotFound {
		return cleanupNeeded, r2VerificationFailed()
	}
	cleanupNeeded = false
	return false, nil
}

// The settings page branches on these codes to point at the failing setup step.
func r2CORSFailed() error {
	return &mediaFailure{400, "R2_CORS_FAILED", "CORS 验证失败：存储桶需允许本站来源的 GET、PUT 请求"}
}
func r2WriteFailed() error {
	return &mediaFailure{400, "R2_WRITE_FAILED", "测试对象写入失败，请重试；若持续失败，请检查 S3 API 地址、存储桶名称和 API 令牌权限"}
}
func r2PublicAccessFailed() error {
	return &mediaFailure{400, "R2_PUBLIC_ACCESS_FAILED", "公开访问域名无法读取测试对象：请确认已开启公开访问且域名指向此存储桶"}
}
func r2PermissionFailed() error {
	return &mediaFailure{400, "R2_PERMISSION_FAILED", "API 令牌权限不足：需要对象读取、列举和删除权限"}
}
func r2VerificationFailed() error {
	return &mediaFailure{400, "R2_VERIFICATION_FAILED", "R2 验证失败，请检查密钥的读写删除权限、公开访问和 CORS 配置"}
}

// sliceVerifyFailure keeps the check-specific failure and maps anything else
// (encoding, key composition, signing errors) to the generic code.
func sliceVerifyFailure(err error) error {
	var failure *mediaFailure
	if errors.As(err, &failure) {
		return failure
	}
	return r2VerificationFailed()
}

func headerHas(value, token string) bool {
	for _, part := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}
