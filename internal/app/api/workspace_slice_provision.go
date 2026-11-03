package api

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	"github.com/xxww0098/podhub-go/internal/platform/cloudflare"
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

func (s *Server) provisionWorkspaceSliceStorage(w http.ResponseWriter, r *http.Request) {
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
		AccountID     string  `json:"account_id"`
		PublicConsent bool    `json:"public_access"`
		Bucket        *string `json:"bucket"`
	}
	if decodeMedia(r, &in) != nil || !in.PublicConsent || !cloudflare.ValidBucket(in.AccountID, "podhub-slices") {
		writeMediaFailure(w, &mediaFailure{400, "VALIDATION", "请选择 Cloudflare 账户并确认切片图片可公开读取"})
		return
	}
	if in.Bucket != nil && !cloudflare.ValidBucket(in.AccountID, *in.Bucket) {
		writeMediaFailure(w, &mediaFailure{400, "WORKSPACE_STORAGE_BUCKET_INVALID", "桶名须为 3–63 个字符，仅允许小写字母、数字和连字符，首尾须为字母或数字，不能包含中文"})
		return
	}
	if s.Pool == nil || len(s.SliceStorageKey) != 32 || !s.SliceDeleteAllowed {
		writeMediaFailure(w, mediaUnavailable())
		return
	}
	// A session lock spans committed checkpoints; a process crash releases it.
	conn, err := s.Pool.Acquire(r.Context())
	if err != nil {
		writeMediaFailure(w, mediaUnavailable())
		return
	}
	var locked bool
	err = conn.QueryRow(r.Context(), `SELECT pg_try_advisory_lock(hashtextextended('workspace-slice-provision:'||$1::bigint::text,0))`, actor.OrgID).Scan(&locked)
	if err != nil || !locked {
		conn.Release()
		writeMediaFailure(w, &mediaFailure{409, "WORKSPACE_STORAGE_BUSY", "存储桶正在创建，请稍后刷新"})
		return
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if _, err := conn.Exec(ctx, `SELECT pg_advisory_unlock(hashtextextended('workspace-slice-provision:'||$1::bigint::text,0))`, actor.OrgID); err != nil {
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
		if in.Bucket != nil && *in.Bucket != current.Account.Bucket {
			writeMediaFailure(w, &mediaFailure{409, "WORKSPACE_STORAGE_BUCKET_FIXED", "此空间已创建存储桶，不能修改桶名"})
			return
		}
		s.getWorkspaceSliceStorage(w, r)
		return
	}
	token, err := s.cloudflareToken(r)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	origin, err := url.Parse(s.PublicURL)
	if err != nil || origin.Host == "" || origin.Path != "" && origin.Path != "/" {
		writeMediaFailure(w, &mediaFailure{503, "CLOUDFLARE_UNAVAILABLE", "请先配置本站公开访问地址"})
		return
	}
	bucket := ""
	if in.Bucket != nil {
		bucket = *in.Bucket
	}
	err = s.provisionSlice(r.Context(), actor, workspace, token, in.AccountID, origin.Scheme+"://"+origin.Host, bucket)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	s.getWorkspaceSliceStorage(w, r)
}

func (s *Server) provisionSlice(ctx context.Context, actor access.Principal, workspace, token, accountID, origin, bucket string) error {
	var provision *mediarepo.SliceProvision
	var inserted bool
	err := s.ownerStorageTx(ctx, actor, func(tx pgx.Tx) error {
		var err error
		provision, inserted, err = mediarepo.ReserveSliceProvision(ctx, tx, actor.OrgID, actor.UserID, accountID, bucket)
		return err
	})
	if err != nil {
		if errors.Is(err, mediarepo.ErrSliceBucketNameInUse) {
			return &mediaFailure{409, "WORKSPACE_STORAGE_BUCKET_EXISTS", "该 Cloudflare 账户下的桶名已被使用，请换一个名称"}
		}
		return err
	}
	if provision.AccountID != accountID {
		return &mediaFailure{409, "WORKSPACE_STORAGE_ACCOUNT_MISMATCH", "此空间已开始创建存储桶，请使用原 Cloudflare 账户继续"}
	}
	if bucket != "" && bucket != provision.Bucket {
		return &mediaFailure{409, "WORKSPACE_STORAGE_BUCKET_FIXED", "此空间已开始创建存储桶，请使用原名称继续"}
	}
	checkpoint := func(phase, code string) error {
		return s.ownerStorageTx(ctx, actor, func(tx pgx.Tx) error {
			return mediarepo.SetSliceProvision(ctx, tx, actor.OrgID, actor.UserID, phase, code)
		})
	}
	if provision.Phase == "blocked" || provision.Phase == "token_creating" {
		return &mediaFailure{409, "WORKSPACE_STORAGE_ATTENTION", "上次创建结果需人工核对，请在 Cloudflare 控制台检查此桶和同名 PodHub 令牌；系统不会重复创建"}
	}
	if provision.Phase == "creating" {
		if provision.CustomName {
			// A predictable name is never adopted after an interrupted creation.
			if err := checkpoint("blocked", "create_unconfirmed"); err != nil {
				return err
			}
			_, err = s.Cloudflare.CreateBucket(ctx, token, accountID, provision.Bucket)
			if err != nil {
				var upstream *cloudflare.Error
				if errors.As(err, &upstream) && !upstream.Unconfirmed && upstream.Status >= 400 && upstream.Status < 500 {
					if cleanupErr := s.ownerStorageTx(ctx, actor, func(tx pgx.Tx) error {
						return mediarepo.DiscardRejectedSliceProvision(ctx, tx, actor.OrgID, actor.UserID, provision.ID)
					}); cleanupErr != nil {
						return cleanupErr
					}
					if upstream.Status == 409 {
						return &mediaFailure{409, "WORKSPACE_STORAGE_BUCKET_EXISTS", "该 Cloudflare 账户下已存在同名存储桶，请换一个名称"}
					}
					return &mediaFailure{502, "WORKSPACE_STORAGE_CREATE_REJECTED", "Cloudflare 拒绝创建，请检查桶名、R2 开通状态和授权后重试"}
				}
			}
		} else if inserted {
			_, err = s.Cloudflare.CreateBucket(ctx, token, accountID, provision.Bucket)
		} else {
			_, err = s.Cloudflare.Bucket(ctx, token, accountID, provision.Bucket)
			var upstream *cloudflare.Error
			if errors.As(err, &upstream) && upstream.Status == 404 {
				_, err = s.Cloudflare.CreateBucket(ctx, token, accountID, provision.Bucket)
			}
		}
		if err != nil {
			var upstream *cloudflare.Error
			if !provision.CustomName {
				if errors.As(err, &upstream) && upstream.Status == 409 {
					_ = checkpoint("blocked", "bucket_exists")
				} else {
					_ = checkpoint("creating", "create_unconfirmed")
				}
			}
			return &mediaFailure{502, "WORKSPACE_STORAGE_CREATE_UNCONFIRMED", "尚未确认存储桶创建结果，请重新授权原账户后继续核对"}
		}
		if err := checkpoint("bucket_ready", ""); err != nil {
			return err
		}
		provision.Phase = "bucket_ready"
	}
	if provision.Phase == "bucket_ready" {
		publicURL, err := s.Cloudflare.ConfigureBucket(ctx, token, accountID, provision.Bucket, origin)
		if err != nil {
			_ = checkpoint("bucket_ready", "configure_failed")
			return &mediaFailure{502, "WORKSPACE_STORAGE_CONFIGURE_FAILED", "存储桶已创建，公开访问或跨域配置未通过，请确认 R2 权限后重试"}
		}
		if err := checkpoint("token_creating", ""); err != nil {
			return err
		}
		credential, err := s.Cloudflare.CreateBucketCredential(ctx, token, accountID, provision.Bucket)
		if err != nil {
			var upstream *cloudflare.Error
			if errors.As(err, &upstream) && !upstream.Unconfirmed {
				_ = checkpoint("bucket_ready", "credential_denied")
			}
			return &mediaFailure{502, "WORKSPACE_STORAGE_CREDENTIAL_FAILED", "未取得存储桶专用凭据，请核对 Cloudflare 令牌管理授权；结果未知时需到控制台核对"}
		}
		prefix, _ := media.SlicePrefix(provision.ID)
		account := sign.Account{ID: provision.ID, Provider: sign.ProviderCloudflare, Endpoint: "https://" + accountID + ".r2.cloudflarestorage.com", Bucket: provision.Bucket, PublicBaseURL: publicURL, Region: "auto", ForcePathStyle: true, AccessKeyID: credential.ID, SecretAccessKey: credential.Secret, KeyPrefix: prefix}
		err = s.ownerStorageTx(ctx, actor, func(tx pgx.Tx) error {
			if err := mediarepo.StageSliceStorage(ctx, tx, actor.OrgID, actor.UserID, account, s.SliceStorageKey); err != nil {
				return err
			}
			return mediarepo.SetSliceProvision(ctx, tx, actor.OrgID, actor.UserID, "verifying", "")
		})
		if err != nil {
			cleanup, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if s.Cloudflare.DeleteCredential(cleanup, token, accountID, credential.ID) == nil {
				_ = checkpoint("bucket_ready", "credential_store_failed")
			}
			return err
		}
	}
	var candidate *mediarepo.SliceStorage
	err = s.transitTx(ctx, actor, false, func(tx pgx.Tx) error {
		var err error
		candidate, err = mediarepo.CandidateSliceStorage(ctx, tx, actor.OrgID, provision.ID, s.SliceStorageKey)
		return err
	})
	if err != nil {
		return err
	}
	verify := s.VerifySlice
	if verify == nil {
		verify = verifySliceStorage
	}
	if _, err := verify(ctx, candidate.Account, workspace, origin); err != nil {
		_ = checkpoint("verifying", "verification_failed")
		return sliceVerifyFailure(err)
	}
	return s.ownerStorageTx(ctx, actor, func(tx pgx.Tx) error {
		if err := mediarepo.ActivateSliceStorage(ctx, tx, actor.OrgID, actor.UserID, provision.ID); err != nil {
			return err
		}
		return mediarepo.SetSliceProvision(ctx, tx, actor.OrgID, actor.UserID, "ready", "")
	})
}
