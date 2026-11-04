package api

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func workspaceStorageOwnerRequired() error {
	return &mediaFailure{403, "WORKSPACE_STORAGE_OWNER_REQUIRED", "只有工作空间所有者可以创建或管理存储桶"}
}

func (s *Server) ownerStorageTx(ctx context.Context, actor access.Principal, fn func(pgx.Tx) error) error {
	if actor.WorkspaceRole != "owner" {
		return workspaceStorageOwnerRequired()
	}
	return s.transitTx(ctx, actor, true, func(tx pgx.Tx) error {
		var id int64
		if err := tx.QueryRow(ctx, `SELECT id FROM organizations WHERE id=$1 AND owner_user_id=$2 AND dissolved_at IS NULL FOR SHARE`, actor.OrgID, actor.UserID).Scan(&id); err != nil {
			return workspaceStorageOwnerRequired()
		}
		return fn(tx)
	})
}

// configureWorkspaceSliceStorage stores a workspace owner's R2 bucket
// credential after it has proved upload, readback, listing and delete access.
// A space has one active configuration; members only use it.
func (s *Server) configureWorkspaceSliceStorage(w http.ResponseWriter, r *http.Request) {
	actor, workspace, err := s.mediaActor(r, "")
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	if actor.WorkspaceRole != "owner" {
		writeMediaFailure(w, workspaceStorageOwnerRequired())
		return
	}
	var in struct {
		Endpoint        string `json:"endpoint"`
		Bucket          string `json:"bucket"`
		PublicBaseURL   string `json:"public_base_url"`
		AccessKeyID     string `json:"access_key_id"`
		SecretAccessKey string `json:"secret_access_key"`
	}
	if decodeMedia(r, &in) != nil {
		writeMediaFailure(w, &mediaFailure{400, "VALIDATION", "请填写 R2 端点、桶名称、公开访问地址和 API 令牌"})
		return
	}
	id := uuid.NewString()
	prefix, err := media.SlicePrefix(id)
	if err != nil {
		writeMediaFailure(w, mediaUnavailable())
		return
	}
	config := media.Config{
		Role: media.RoleTransit, Provider: "cloudflare", Endpoint: strings.TrimRight(strings.TrimSpace(in.Endpoint), "/"),
		Region: "auto", Bucket: strings.TrimSpace(in.Bucket), KeyPrefix: prefix,
		PublicBaseURL: strings.TrimRight(strings.TrimSpace(in.PublicBaseURL), "/"), ForcePathStyle: true,
		AccessKeyID: strings.TrimSpace(in.AccessKeyID), SecretAccessKey: strings.TrimSpace(in.SecretAccessKey),
	}
	if err := config.ValidateSliceStorage(); err != nil {
		writeMediaFailure(w, sliceConfigFailure(err))
		return
	}
	if s.Pool == nil || len(s.SliceStorageKey) != 32 {
		writeMediaFailure(w, mediaUnavailable())
		return
	}
	browserOrigin, err := sliceBrowserOrigin(s.PublicURL)
	if err != nil {
		writeMediaFailure(w, &mediaFailure{503, "UNAVAILABLE", "请先配置本站公开访问地址"})
		return
	}
	// One session lock spans verification and activation. A process crash
	// releases it, and a second create cannot activate over the first.
	conn, err := s.Pool.Acquire(r.Context())
	if err != nil {
		writeMediaFailure(w, mediaUnavailable())
		return
	}
	var locked bool
	err = conn.QueryRow(r.Context(), `SELECT pg_try_advisory_lock(hashtextextended('workspace-slice-configure:'||$1::bigint::text,0))`, actor.OrgID).Scan(&locked)
	if err != nil || !locked {
		conn.Release()
		writeMediaFailure(w, &mediaFailure{409, "WORKSPACE_STORAGE_BUSY", "存储桶正在配置，请稍后刷新"})
		return
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if _, err := conn.Exec(ctx, `SELECT pg_advisory_unlock(hashtextextended('workspace-slice-configure:'||$1::bigint::text,0))`, actor.OrgID); err != nil {
			_ = conn.Hijack().Close(ctx)
		} else {
			conn.Release()
		}
	}()
	var current *mediarepo.SliceStorage
	err = s.transitTx(r.Context(), actor, false, func(tx pgx.Tx) error {
		var err error
		current, err = mediarepo.ActiveSliceStorage(r.Context(), tx, actor.OrgID, s.SliceStorageKey)
		return err
	})
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	if current != nil {
		s.getWorkspaceSliceStorage(w, r)
		return
	}
	account := sign.Account{
		ID: id, Provider: sign.ProviderCloudflare, Endpoint: config.Endpoint, Bucket: config.Bucket,
		PublicBaseURL: config.PublicBaseURL, Region: "auto", ForcePathStyle: true,
		AccessKeyID: config.AccessKeyID, SecretAccessKey: config.SecretAccessKey, KeyPrefix: prefix,
	}
	err = s.ownerStorageTx(r.Context(), actor, func(tx pgx.Tx) error {
		return mediarepo.StageSliceStorage(r.Context(), tx, actor.OrgID, actor.UserID, account, s.SliceStorageKey)
	})
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	verify := s.VerifySlice
	if verify == nil {
		verify = verifySliceStorage
	}
	if _, err := verify(r.Context(), account, workspace, browserOrigin); err != nil {
		writeMediaFailure(w, sliceVerifyFailure(err))
		return
	}
	err = s.ownerStorageTx(r.Context(), actor, func(tx pgx.Tx) error {
		return mediarepo.ActivateSliceStorage(r.Context(), tx, actor.OrgID, actor.UserID, id)
	})
	if err != nil {
		writeMediaFailure(w, sliceActivationFailure(err))
		return
	}
	s.getWorkspaceSliceStorage(w, r)
}

// sliceBrowserOrigin is the site origin sent to the browser CORS probe.
func sliceBrowserOrigin(raw string) (string, error) {
	origin, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || origin.Host == "" || (origin.Path != "" && origin.Path != "/") || origin.RawQuery != "" || origin.Fragment != "" {
		return "", errors.New("public origin is not usable")
	}
	return origin.Scheme + "://" + origin.Host, nil
}

var errSliceBucketInUse = &mediaFailure{409, "WORKSPACE_STORAGE_BUCKET_EXISTS", "该存储桶已被其他工作空间使用，请更换存储桶"}

func sliceConfigFailure(err error) error {
	switch {
	case errors.Is(err, media.ErrBucket):
		return &mediaFailure{400, "WORKSPACE_STORAGE_BUCKET_INVALID", "桶名须为 3–63 个小写字母、数字或连字符，首尾须为字母或数字，不能包含中文"}
	case errors.Is(err, media.ErrEndpoint):
		return &mediaFailure{400, "WORKSPACE_STORAGE_ENDPOINT_INVALID", "R2 端点须为 https://<32 位账户 ID>.r2.cloudflarestorage.com"}
	case errors.Is(err, media.ErrPublicHost):
		return &mediaFailure{400, "WORKSPACE_STORAGE_PUBLIC_URL_INVALID", "公开访问地址须为 HTTPS 域名，不能包含端口、路径、查询参数或用户信息"}
	case errors.Is(err, media.ErrIdentity):
		return &mediaFailure{400, "WORKSPACE_STORAGE_CREDENTIAL_INVALID", "请填写 Access Key ID 和 Secret Access Key"}
	default:
		return &mediaFailure{400, "VALIDATION", "存储桶配置无效"}
	}
}

func sliceActivationFailure(err error) error {
	var conflict *pgconn.PgError
	if errors.As(err, &conflict) && conflict.ConstraintName == "workspace_slice_storage_bucket" {
		return errSliceBucketInUse
	}
	return err
}
