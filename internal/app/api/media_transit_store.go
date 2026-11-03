package api

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

func (s *Server) currentTransit(ctx context.Context, tx pgx.Tx, actor access.Principal, account sign.Account) error {
	if s.Media != nil {
		return nil
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended('workspace-slice-storage:'||$1::bigint::text,0))`, actor.OrgID); err != nil {
		return err
	}
	row, err := mediarepo.ActiveSliceStorage(ctx, tx, actor.OrgID, s.SliceStorageKey)
	if err != nil {
		return err
	}
	if row == nil || row.Account.ID != account.ID || transitStorageRevision(row.Account) != transitStorageRevision(account) {
		return mediaConflict()
	}
	return nil
}

func transitBatchCleared(ctx context.Context, tx pgx.Tx, orgID int64, accountID string, batchMS int64) (bool, error) {
	var cleared bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM public.workspace_slice_clear_requests
		WHERE org_id=$1 AND storage_id=$2::uuid AND requested_at>to_timestamp($3::double precision/1000))`, orgID, accountID, batchMS).Scan(&cleared)
	return cleared, err
}

func (s *Server) transitTx(ctx context.Context, actor access.Principal, writing bool, fn func(pgx.Tx) error) error {
	if s.Pool == nil || actor.TokenHash == "" {
		return mediaUnavailable()
	}
	tx, err := tenantx.BeginApp(ctx, s.Pool.Begin, actor.OrgID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	defer writer.Forget(tx)
	if _, err := tx.Exec(ctx, `SET LOCAL statement_timeout = '5s'`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '2s'`); err != nil {
		return err
	}
	// The session and membership remain locked through the final write. An
	// object read outside this transaction never grants authority by itself.
	var present int
	err = tx.QueryRow(ctx, `SELECT 1 FROM account_users u
		JOIN account_profiles profile ON profile.user_id=u.id
		JOIN account_sessions session ON session.user_id=u.id AND session.token_hash=$3
		JOIN organization_members m ON m.user_id=u.id AND m.org_id=$2
		JOIN organizations o ON o.id=m.org_id
		WHERE u.id=$1 AND u.disabled_at IS NULL AND session.expires_at>clock_timestamp()
		  AND m.status='active' AND NOT m.manual_disabled AND NOT m.quota_suspended
		  AND m.role IN ('owner','manager','admin','member','reviewer') AND o.dissolved_at IS NULL
		FOR SHARE OF u,profile,session,m,o`, actor.UserID, actor.OrgID, actor.TokenHash).Scan(&present)
	if errors.Is(err, pgx.ErrNoRows) {
		return &mediaFailure{403, "FORBIDDEN", "登录或工作空间权限已变化"}
	}
	if err != nil {
		return err
	}
	current, err := sqlc.New(tx).ResolveAccount(ctx, actor.TokenHash)
	if err != nil || current.ID != actor.UserID || current.OrgID != actor.OrgID {
		return &mediaFailure{403, "FORBIDDEN", "登录或工作空间权限已变化"}
	}
	if writing {
		if _, err := writer.Assert(ctx, tx, "recipe", writer.ProcessIdentity(), s.now().UnixMilli(), "媒体写入未启用"); err != nil {
			if writer.IsDisabled(err) {
				return &mediaFailure{503, "WRITES_DISABLED", "媒体写入未启用"}
			}
			return err
		}
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Reservations consume the monthly byte allowance as soon as a public PUT is
// issued. Unconfirmed PUTs are still publicly writable, so they cannot refund it.
func (s *Server) reserveTransit(ctx context.Context, actor access.Principal, account sign.Account, leases []transitLease) ([]transitLease, error) {
	err := s.transitTx(ctx, actor, true, func(tx pgx.Tx) error {
		if err := s.currentTransit(ctx, tx, actor, account); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('transit-upload-quota:' || $1::bigint::text, 0))`, actor.OrgID); err != nil {
			return err
		}
		var allowance int64
		if err := tx.QueryRow(ctx, `SELECT CASE WHEN (SELECT c.stores FROM public.subscription_capacity(o.id, clock_timestamp()) c) = 0 THEN 0
			       ELSE p.s3_upload_bytes_monthly END
			FROM organizations o
			JOIN plans p ON p.key=CASE WHEN o.plan_expires_at IS NOT NULL AND o.plan_expires_at<=clock_timestamp() THEN 'free' ELSE o.plan END
			WHERE o.id=$1 AND o.dissolved_at IS NULL FOR SHARE OF p`, actor.OrgID).Scan(&allowance); err != nil {
			return err
		}
		var used int64
		if err := tx.QueryRow(ctx, `SELECT COALESCE(sum(verified_byte_length),0)::bigint FROM media_object_leases
			WHERE org_id=$1 AND first_seen_at>=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, actor.OrgID).Scan(&used); err != nil {
			return err
		}
		for index, lease := range leases {
			if s.Media == nil {
				parsed, ok := objectkey.ParseUploadKey(lease.key)
				if !ok {
					return mediaInvalid()
				}
				cleared, err := transitBatchCleared(ctx, tx, actor.OrgID, account.ID, parsed.BatchMS)
				if err != nil {
					return err
				}
				if cleared {
					return &mediaFailure{400, "MEDIA_UPLOAD_BATCH_INVALID", "切片仓库已清理，请重新准备图片"}
				}
			}
			var reusableKey, reusableBatch, reusableState string
			var reusableExpires time.Time
			err := tx.QueryRow(ctx, `SELECT object_key,batch_id,verification_status,expires_at FROM public.media_object_leases
				WHERE org_id=$1 AND workspace_uuid=$2::uuid AND media_account_id=$3 AND storage_revision=$4
				AND content_hash=$5 AND verified_byte_length=$6 AND right(object_key,length($7::text))=$7
				AND ((verification_status='verified' AND public_ready_at IS NOT NULL AND public_url=$8||object_key)
				 OR (verification_status='pending' AND expires_at>clock_timestamp()
				  AND CASE WHEN batch_id ~ '^[0-9]{13,18}-' THEN split_part(batch_id,'-',1)::numeric
				   > extract(epoch FROM clock_timestamp()-interval '4 hours')*1000 ELSE false END))
				AND retired_at IS NULL AND deleted_at IS NULL AND gc_claim_token IS NULL
				AND CASE WHEN batch_id ~ '^[0-9]{13,18}-' THEN split_part(batch_id,'-',1)::numeric
				 > extract(epoch FROM clock_timestamp()-interval '28 days')*1000 ELSE false END
				AND NOT EXISTS(SELECT 1 FROM public.workspace_slice_clear_requests r
				 WHERE r.org_id=$1 AND r.storage_id::text=$3 AND r.requested_at>first_seen_at)
				ORDER BY verified_at DESC NULLS LAST,first_seen_at LIMIT 1 FOR UPDATE`, actor.OrgID, lease.workspace, account.ID, lease.revision,
				lease.digest, lease.bytes, "/"+lease.digest+"."+lease.extension, strings.TrimRight(account.PublicBaseURL, "/")+"/").Scan(&reusableKey, &reusableBatch, &reusableState, &reusableExpires)
			if err == nil {
				batch := strings.Replace(reusableBatch, "-", ".", 1)
				key, keyErr := objectkey.ComposeBatchedKey(account.KeyPrefix, lease.workspace, lease.digest, lease.extension, batch)
				if keyErr != nil || key != reusableKey {
					return mediaConflict()
				}
				if _, err := tx.Exec(ctx, `UPDATE public.media_object_leases
					SET last_hit_at=clock_timestamp(),expires_at=CASE WHEN verification_status='verified' THEN GREATEST(expires_at,clock_timestamp()+interval '4 hours') ELSE expires_at END,updated_at=clock_timestamp()
					WHERE org_id=$1 AND workspace_uuid=$2::uuid AND batch_id=$3 AND content_hash=$4`, actor.OrgID, lease.workspace, reusableBatch, lease.digest); err != nil {
					return err
				}
				lease.key, lease.batch, lease.reused = reusableKey, reusableBatch, reusableState == "verified"
				lease.expires = reusableExpires
				leases[index] = lease
				continue
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			var priorKey, priorAccount, priorState string
			var priorSize, priorRevision int64
			var expired, retired bool
			err = tx.QueryRow(ctx, `SELECT object_key,media_account_id,verification_status,COALESCE(verified_byte_length,0),storage_revision,
				expires_at<=clock_timestamp(),retired_at IS NOT NULL OR deleted_at IS NOT NULL
				FROM media_object_leases WHERE org_id=$1 AND workspace_uuid=$2::uuid AND batch_id=$3 AND content_hash=$4 FOR UPDATE`,
				actor.OrgID, lease.workspace, lease.batch, lease.digest).Scan(&priorKey, &priorAccount, &priorState, &priorSize, &priorRevision, &expired, &retired)
			if err == nil {
				if priorKey != lease.key || priorAccount != account.ID || priorSize != lease.bytes || priorRevision != lease.revision || expired || retired || priorState == "rejected" {
					return mediaConflict()
				}
				if _, err := tx.Exec(ctx, `UPDATE media_object_leases SET last_hit_at=clock_timestamp(),updated_at=clock_timestamp()
					WHERE org_id=$1 AND workspace_uuid=$2::uuid AND batch_id=$3 AND content_hash=$4`, actor.OrgID, lease.workspace, lease.batch, lease.digest); err != nil {
					return err
				}
				continue
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if allowance <= 0 || lease.bytes > allowance-used {
				return &mediaFailure{403, "FORBIDDEN", "本月媒体上传额度已用尽"}
			}
			if _, err := tx.Exec(ctx, `INSERT INTO media_object_leases
				(workspace_uuid,batch_id,content_hash,org_id,object_key,media_account_id,first_seen_at,last_hit_at,expires_at,verification_status,verified_byte_length,storage_revision,slice_gc_tracked)
				VALUES($1::uuid,$2,$3,$4,$5,$6,clock_timestamp(),clock_timestamp(),$7,'pending',$8,$9,true)`,
				lease.workspace, lease.batch, lease.digest, actor.OrgID, lease.key, account.ID, lease.expires, lease.bytes, lease.revision); err != nil {
				return err
			}
			used += lease.bytes
		}
		return nil
	})
	return leases, err
}

func transitRow(ctx context.Context, tx pgx.Tx, actor access.Principal, account sign.Account, lease transitLease) (string, error) {
	if parsed, ok := objectkey.ParseUploadKey(lease.key); ok && uuid.Validate(account.ID) == nil {
		cleared, err := transitBatchCleared(ctx, tx, actor.OrgID, account.ID, parsed.BatchMS)
		if err != nil {
			return "", err
		}
		if cleared {
			return "", &mediaFailure{400, "MEDIA_UPLOAD_BATCH_INVALID", "切片仓库已清理，请重新准备图片"}
		}
	}
	var state string
	err := tx.QueryRow(ctx, `SELECT verification_status FROM media_object_leases
		WHERE org_id=$1 AND workspace_uuid=$2::uuid AND batch_id=$3 AND content_hash=$4
		  AND object_key=$5 AND media_account_id=$6 AND storage_revision=$7 AND verified_byte_length=$8
		  AND expires_at>clock_timestamp() AND retired_at IS NULL AND deleted_at IS NULL
		  AND verification_status IN ('pending','verified') FOR UPDATE`, actor.OrgID, lease.workspace, lease.batch, lease.digest,
		lease.key, account.ID, lease.revision, lease.bytes).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", mediaConflict()
	}
	return state, err
}

func (s *Server) checkTransit(ctx context.Context, actor access.Principal, account sign.Account, lease transitLease) error {
	return s.transitTx(ctx, actor, true, func(tx pgx.Tx) error {
		if err := s.currentTransit(ctx, tx, actor, account); err != nil {
			return err
		}
		_, err := transitRow(ctx, tx, actor, account, lease)
		return err
	})
}

func (s *Server) commitTransit(ctx context.Context, actor access.Principal, account sign.Account, lease transitLease, width, height int) (bool, error) {
	var deduplicated bool
	err := s.transitTx(ctx, actor, true, func(tx pgx.Tx) error {
		if err := s.currentTransit(ctx, tx, actor, account); err != nil {
			return err
		}
		state, err := transitRow(ctx, tx, actor, account, lease)
		if err != nil {
			return err
		}
		deduplicated = state == "verified"
		_, err = tx.Exec(ctx, `UPDATE media_object_leases SET verification_status='verified',verified_at=clock_timestamp(),
			public_ready_at=clock_timestamp(),public_url=$5,verified_width=$6,verified_height=$7,last_hit_at=clock_timestamp(),
			expires_at=GREATEST(expires_at,clock_timestamp()+interval '4 hours'),updated_at=clock_timestamp()
			WHERE org_id=$1 AND workspace_uuid=$2::uuid AND batch_id=$3 AND content_hash=$4`,
			actor.OrgID, lease.workspace, lease.batch, lease.digest, sign.PublicURL(account, lease.key), width, height)
		return err
	})
	return deduplicated, err
}

func (s *Server) findTransit(ctx context.Context, actor access.Principal, account sign.Account, workspace, digest, extension string) (transitLease, bool, error) {
	var lease transitLease
	if len(digest) != 64 || strings.ToLower(digest) != digest || (extension != "jpg" && extension != "png") {
		return lease, false, mediaInvalid()
	}
	found := false
	err := s.transitTx(ctx, actor, false, func(tx pgx.Tx) error {
		if err := s.currentTransit(ctx, tx, actor, account); err != nil {
			return err
		}
		var key string
		var size int64
		var expires time.Time
		err := tx.QueryRow(ctx, `SELECT object_key,verified_byte_length,expires_at FROM media_object_leases
			WHERE org_id=$1 AND workspace_uuid=$2::uuid AND content_hash=$3 AND media_account_id=$4 AND storage_revision=$5
			 AND verification_status='verified' AND public_ready_at IS NOT NULL AND retired_at IS NULL AND deleted_at IS NULL
			 AND gc_claim_token IS NULL AND expires_at>clock_timestamp()
			 AND CASE WHEN batch_id ~ '^[0-9]{13,18}-' THEN split_part(batch_id,'-',1)::numeric
			  > extract(epoch FROM clock_timestamp()-interval '28 days')*1000 ELSE false END
			 ORDER BY verified_at DESC LIMIT 1`, actor.OrgID, workspace, digest, account.ID, transitStorageRevision(account)).Scan(&key, &size, &expires)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		identity := objectkey.BatchIdentity(key)
		batch := strings.Replace(identity, "-", ".", 1)
		expected, err := objectkey.ComposeBatchedKey(account.KeyPrefix, workspace, digest, extension, batch)
		if err != nil || expected != key {
			return nil
		}
		lease = transitLease{workspace: workspace, batch: identity, digest: digest, extension: extension,
			key: key, bytes: size, revision: transitStorageRevision(account), expires: expires}
		found = true
		return nil
	})
	return lease, found, err
}
