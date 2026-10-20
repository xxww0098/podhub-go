// Package mediarepo is the pgx implementation of the storage registry ports.
//
// Every statement runs in a podhub_app transaction for one org and takes the
// per-key shared fence before it reads. All transactions run READ COMMITTED:
// the fence's post-lock lookups need a fresh statement snapshot.
package mediarepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/media/domain/storageregistry"
)

// BeginApp opens a podhub_app transaction for one org. The process passes
// tenant.BeginApp; this package does not import tenant.
type BeginApp func(ctx context.Context, begin func(context.Context) (pgx.Tx, error), orgID int64) (pgx.Tx, error)

// ErrUnavailable is the repo's single transport failure. The service owns the
// user-facing message; this sentinel only marks "try again later".
var ErrUnavailable = errors.New("storage registry unavailable")

// Registry is the storage_objects / storage_uploads store.
type Registry struct {
	pool  *pgxpool.Pool
	begin BeginApp
}

// New keeps the pool and the tenant opener.
func New(pool *pgxpool.Pool, begin BeginApp) Registry {
	return Registry{pool: pool, begin: begin}
}

func (r Registry) withTx(ctx context.Context, orgID int64, fn func(pgx.Tx) error) error {
	if r.pool == nil || r.begin == nil {
		return ErrUnavailable
	}
	tx, err := r.begin(ctx, r.pool.Begin, orgID)
	if err != nil {
		return ErrUnavailable
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SET LOCAL statement_timeout = '5s'"); err != nil {
		return ErrUnavailable
	}
	if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = '2s'"); err != nil {
		return ErrUnavailable
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

const objectColumns = `id::text, bucket, bucket_identity, object_key, dedupe_scope,
    encode(sha256, 'hex'), byte_length, content_type, extension, state`

// Lookup reads the rows a presign or confirm decision needs: the live contents
// of one dedupe scope, and everything known about the exact key. It takes the
// shared fence first so a concurrent collector cannot delete the key after the
// caller decides to reuse it.
func (r Registry) Lookup(ctx context.Context, claim storageregistry.Claim) ([]storageregistry.Object, []storageregistry.Object, error) {
	var byScope, byKey []storageregistry.Object
	err := r.withTx(ctx, 0, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT public.lock_storage_key_shared($1, $2)`, claim.BucketIdentity, claim.ObjectKey); err != nil {
			return mapErr(err)
		}
		rows, err := tx.Query(ctx, `
			SELECT `+objectColumns+`
			  FROM public.storage_objects
			 WHERE bucket_identity = $1 AND dedupe_scope = $2
			   AND sha256 = $3::bytea AND extension = $4
			 ORDER BY created_at`,
			claim.BucketIdentity, claim.DedupeScope, claim.SHA256Hex, claim.Extension)
		if err != nil {
			return mapErr(err)
		}
		byScope, err = scanObjects(rows)
		if err != nil {
			return err
		}
		rows, err = tx.Query(ctx, `
			SELECT `+objectColumns+`
			  FROM public.storage_objects
			 WHERE bucket_identity = $1 AND object_key = $2
			 ORDER BY created_at`,
			claim.BucketIdentity, claim.ObjectKey)
		if err != nil {
			return mapErr(err)
		}
		byKey, err = scanObjects(rows)
		return err
	})
	if err != nil {
		return nil, nil, err
	}
	return byScope, byKey, nil
}

func scanObjects(rows pgx.Rows) ([]storageregistry.Object, error) {
	defer rows.Close()
	var out []storageregistry.Object
	for rows.Next() {
		var row storageregistry.Object
		if err := rows.Scan(&row.ID, &row.Bucket, &row.BucketIdentity, &row.ObjectKey,
			&row.DedupeScope, &row.SHA256Hex, &row.ByteLength, &row.ContentType,
			&row.Extension, &row.State); err != nil {
			return nil, mapErr(err)
		}
		out = append(out, row)
	}
	return out, mapErr(rows.Err())
}

// BeginUpload inserts a pending upload row. A previous expired or aborted row
// for the same actor and purpose is marked superseded rather than deleted:
// the lease belongs to the key, not to the row, and an abandoned row must not
// block a retry.
func (r Registry) BeginUpload(ctx context.Context, row storageregistry.Upload) (string, error) {
	var id string
	err := r.withTx(ctx, row.OrgID, func(tx pgx.Tx) error {
		// A dead row still names a retired key; later confirms of it must
		// fail loudly instead of matching a new lease. Marking it superseded
		// keeps the history and frees the (bucket, key, actor, purpose) slot.
		if _, err := tx.Exec(ctx, `
			UPDATE public.storage_uploads
			   SET state = 'superseded'
			 WHERE bucket_identity = $1 AND object_key = $2 AND actor_id = $3
			   AND purpose_kind = $4 AND purpose_id = $5
			   AND state IN ('expired', 'aborted')`,
			row.BucketIdentity, row.ObjectKey, row.ActorID, string(row.PurposeKind), row.PurposeID); err != nil {
			return mapErr(err)
		}
		// A retried presign of the same key joins the live lease instead of
		// failing: the lease is per key, and the browser may legitimately ask
		// twice before it uploads.
		err := tx.QueryRow(ctx, `
			INSERT INTO public.storage_uploads
			    (actor_id, org_id, purpose_kind, purpose_id, bucket, bucket_identity,
			     object_key, dedupe_scope, sha256, byte_length, content_type, extension,
			     multipart_id, state, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bytea, $10, $11, $12, NULLIF($13, ''), 'pending', $14)
			ON CONFLICT (bucket_identity, object_key, actor_id, purpose_kind, purpose_id)
			    WHERE state IN ('pending', 'confirmed')
			DO UPDATE SET expires_at = EXCLUDED.expires_at, updated_at = clock_timestamp()
			    WHERE storage_uploads.state = 'pending'
			RETURNING id::text`,
			row.ActorID, orgID(row.OrgID), string(row.PurposeKind), row.PurposeID,
			string(row.Bucket), row.BucketIdentity, row.ObjectKey, row.DedupeScope,
			row.SHA256Hex, row.ByteLength, row.ContentType, string(row.Extension),
			row.MultipartID, row.ExpiresAt.UTC(),
		).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			// A confirmed row already owns this key. Reuse is decided by the
			// object lookup, so reaching here means the registry and the
			// bucket disagree; refuse instead of minting a second lease.
			return storageregistry.ErrState
		}
		if err != nil {
			return mapErr(err)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return id, nil
}

// Upload reads one pending upload for this actor and org. Another org's row is
// indistinguishable from a missing one.
func (r Registry) Upload(ctx context.Context, uploadID string, actorID, orgID int64) (storageregistry.Upload, error) {
	var out storageregistry.Upload
	err := r.withTx(ctx, orgID, func(tx pgx.Tx) error {
		var bucket, kind, extension string
		var state string
		err := tx.QueryRow(ctx, `
			SELECT id::text, actor_id, COALESCE(org_id, 0), purpose_kind, purpose_id,
			       bucket, bucket_identity, object_key, dedupe_scope, encode(sha256, 'hex'),
			       byte_length, content_type, extension, COALESCE(multipart_id, ''), state, expires_at
			  FROM public.storage_uploads
			 WHERE id = $1::uuid AND actor_id = $2
			   AND (org_id = $3 OR org_id IS NULL)`,
			uploadID, actorID, orgID).Scan(
			&out.ID, &out.ActorID, &out.OrgID, &kind, &out.PurposeID,
			&bucket, &out.BucketIdentity, &out.ObjectKey, &out.DedupeScope, &out.SHA256Hex,
			&out.ByteLength, &out.ContentType, &extension, &out.MultipartID, &state, &out.ExpiresAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return storageregistry.ErrState
		}
		if err != nil {
			return mapErr(err)
		}
		out.PurposeKind, out.Bucket, out.Extension = kind, bucket, extension
		out.State = storageregistry.UploadState(state)
		return nil
	})
	return out, err
}

// Confirm inserts or reuses the registry row and marks the upload confirmed.
// The upload row is locked first, so two confirms of the same upload cannot
// both insert.
func (r Registry) Confirm(ctx context.Context, uploadID string, decision storageregistry.ConfirmDecision) (string, error) {
	var objectID string
	err := r.withTx(ctx, 0, func(tx pgx.Tx) error {
		claim := decision.Claim
		if _, err := tx.Exec(ctx, `SELECT public.lock_storage_key_shared($1, $2)`, claim.BucketIdentity, claim.ObjectKey); err != nil {
			return mapErr(err)
		}
		var orgID *int64
		var state string
		err := tx.QueryRow(ctx, `
			SELECT org_id, state FROM public.storage_uploads
			 WHERE id = $1::uuid FOR UPDATE`, uploadID).Scan(&orgID, &state)
		if errors.Is(err, pgx.ErrNoRows) {
			return storageregistry.ErrState
		}
		if err != nil {
			return mapErr(err)
		}
		if state != string(storageregistry.UploadPending) {
			return storageregistry.ErrState
		}
		if decision.Reuse {
			if _, err := tx.Exec(ctx, `
				UPDATE public.storage_uploads
				   SET state = 'confirmed', confirmed_at = clock_timestamp(), object_id = $2::uuid
				 WHERE id = $1::uuid AND state = 'pending'`, uploadID, decision.ObjectID); err != nil {
				return mapErr(err)
			}
			objectID = decision.ObjectID
			return nil
		}
		err = tx.QueryRow(ctx, `
			INSERT INTO public.storage_objects
			    (bucket, bucket_identity, object_key, dedupe_scope, owner_org_id,
			     sha256, byte_length, content_type, extension, state)
			VALUES ($1, $2, $3, $4, $5, $6::bytea, $7, $8, $9, 'live')
			ON CONFLICT (bucket_identity, dedupe_scope, sha256, extension) DO NOTHING
			RETURNING id::text`,
			claim.Bucket, claim.BucketIdentity, claim.ObjectKey, claim.DedupeScope,
			orgID, claim.SHA256Hex, claim.ByteLength, claim.ContentType, claim.Extension).Scan(&objectID)
		if errors.Is(err, pgx.ErrNoRows) {
			// A concurrent confirm inserted the same content first. The
			// unique constraint is the arbiter; read the winner back.
			err = tx.QueryRow(ctx, `
				SELECT id::text FROM public.storage_objects
				 WHERE bucket_identity = $1 AND dedupe_scope = $2
				   AND sha256 = $3::bytea AND extension = $4`,
				claim.BucketIdentity, claim.DedupeScope, claim.SHA256Hex, claim.Extension).Scan(&objectID)
		}
		if err != nil {
			return mapErr(err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE public.storage_uploads
			   SET state = 'confirmed', confirmed_at = clock_timestamp(), object_id = $2::uuid
			 WHERE id = $1::uuid AND state = 'pending'`, uploadID, objectID); err != nil {
			return mapErr(err)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return objectID, nil
}

// ExpireUnconfirmed stops a pending claim whose object was already stored.
func (r Registry) ExpireUnconfirmed(ctx context.Context, uploadID string) error {
	return r.withTx(ctx, 0, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE public.storage_uploads SET state = 'expired'
			 WHERE id = $1::uuid AND state = 'pending'`, uploadID)
		return mapErr(err)
	})
}

func orgID(value int64) any {
	if value <= 0 {
		return nil
	}
	return value
}

func mapErr(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, storageregistry.ErrConflict), errors.Is(err, storageregistry.ErrNotLive),
		errors.Is(err, storageregistry.ErrExpired), errors.Is(err, storageregistry.ErrState):
		return err
	}
	return ErrUnavailable
}
