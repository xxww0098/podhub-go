package mediarepo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/media/contract"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

var ErrSliceStorageUnavailable = errors.New("slice storage is unavailable")

type SliceStorage struct {
	OrgID             int64
	CreatedBy         int64
	Account           sign.Account
	Hint              string
	ClearAtMinute     *int32
	ClearConfiguredAt time.Time
}

type sliceSecret struct {
	Access string `json:"access"`
	Secret string `json:"secret"`
}

func sliceAAD(userID int64, id string) string {
	// Keep the original encryption context when migrating existing credentials.
	return fmt.Sprintf("podhub:user-slice:%d:%s", userID, id)
}

func setSliceActor(ctx context.Context, tx pgx.Tx, userID int64) error {
	if userID <= 0 {
		return ErrSliceStorageUnavailable
	}
	_, err := tx.Exec(ctx, `SELECT set_config('app.slice_storage_actor_id', $1, true)`, strconv.FormatInt(userID, 10))
	return err
}

// ActiveSliceStorage reads the current workspace's shared active configuration.
func ActiveSliceStorage(ctx context.Context, tx pgx.Tx, orgID int64, key []byte) (*SliceStorage, error) {
	row := tx.QueryRow(ctx, `SELECT id::text,COALESCE(org_id,0),created_by,endpoint,bucket,public_base_url,access_key_hint,secret_nonce,secret_ciphertext,clear_at_minute,clear_configured_at
		FROM public.workspace_slice_storage WHERE org_id=$1 AND retired_at IS NULL`, orgID)
	storage, err := scanSliceStorage(row, key)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return storage, err
}

type sliceScanner interface{ Scan(...any) error }

func scanSliceStorage(row sliceScanner, key []byte) (*SliceStorage, error) {
	var out SliceStorage
	var nonce, ciphertext []byte
	if err := row.Scan(&out.Account.ID, &out.OrgID, &out.CreatedBy, &out.Account.Endpoint, &out.Account.Bucket, &out.Account.PublicBaseURL, &out.Hint, &nonce, &ciphertext, &out.ClearAtMinute, &out.ClearConfiguredAt); err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, ErrSliceStorageUnavailable
	}
	raw, err := seal.OpenBlob(key, sliceAAD(out.CreatedBy, out.Account.ID), nonce, ciphertext)
	if err != nil {
		return nil, ErrSliceStorageUnavailable
	}
	var secret sliceSecret
	if json.Unmarshal(raw, &secret) != nil || secret.Access == "" || secret.Secret == "" {
		return nil, ErrSliceStorageUnavailable
	}
	prefix, err := contract.SlicePrefix(out.Account.ID)
	if err != nil {
		return nil, ErrSliceStorageUnavailable
	}
	out.Account.Provider, out.Account.Region, out.Account.ForcePathStyle = sign.ProviderCloudflare, "auto", true
	out.Account.KeyPrefix, out.Account.AccessKeyID, out.Account.SecretAccessKey = prefix, secret.Access, secret.Secret
	return &out, nil
}

// StageSliceStorage preserves the credential for cleanup even if verification is interrupted.
func StageSliceStorage(ctx context.Context, tx pgx.Tx, orgID, userID int64, account sign.Account, key []byte) error {
	if len(key) != 32 || account.AccessKeyID == "" || account.SecretAccessKey == "" {
		return ErrSliceStorageUnavailable
	}
	if _, err := contract.SlicePrefix(account.ID); err != nil {
		return err
	}
	if err := setSliceActor(ctx, tx, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('workspace-slice-storage:'||$1::bigint::text,0))`, orgID); err != nil {
		return err
	}
	raw, err := json.Marshal(sliceSecret{Access: account.AccessKeyID, Secret: account.SecretAccessKey})
	if err != nil {
		return err
	}
	nonce, ciphertext, err := seal.SealBlob(key, sliceAAD(userID, account.ID), raw)
	if err != nil {
		return err
	}
	hint := account.AccessKeyID
	if len(hint) > 4 {
		hint = hint[len(hint)-4:]
	}
	_, err = tx.Exec(ctx, `INSERT INTO public.workspace_slice_storage(id,org_id,created_by,endpoint,bucket,public_base_url,access_key_hint,secret_nonce,secret_ciphertext,retired_at)
		VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())`, account.ID, orgID, userID, account.Endpoint, account.Bucket, account.PublicBaseURL, hint, nonce, ciphertext)
	return err
}

// ActivateSliceStorage switches identities atomically while retaining old cleanup targets.
func ActivateSliceStorage(ctx context.Context, tx pgx.Tx, orgID, userID int64, id string) error {
	if err := setSliceActor(ctx, tx, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('workspace-slice-storage:'||$1::bigint::text,0))`, orgID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE public.workspace_slice_storage SET retired_at=clock_timestamp() WHERE org_id=$1 AND retired_at IS NULL`, orgID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE public.workspace_slice_storage SET retired_at=NULL WHERE id=$1::uuid AND org_id=$2 AND retired_at IS NOT NULL`, id, orgID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrSliceStorageUnavailable
	}
	return nil
}

func SetSliceCleanupPolicy(ctx context.Context, tx pgx.Tx, orgID, userID int64, id string, minute *int32) error {
	if err := setSliceActor(ctx, tx, userID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE public.workspace_slice_storage SET clear_at_minute=$3,clear_configured_at=clock_timestamp()
		WHERE org_id=$1 AND id=$2::uuid AND retired_at IS NULL`, orgID, id, minute)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrSliceStorageUnavailable
	}
	return nil
}

// ListSliceStorage includes retired credentials so their old uploads can be swept.
func ListSliceStorage(ctx context.Context, tx pgx.Tx, key []byte) ([]SliceStorage, error) {
	rows, err := tx.Query(ctx, `SELECT id::text,COALESCE(org_id,0),created_by,endpoint,bucket,public_base_url,access_key_hint,secret_nonce,secret_ciphertext,clear_at_minute,clear_configured_at FROM public.workspace_slice_storage ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []SliceStorage
	var failure error
	for rows.Next() {
		item, err := scanSliceStorage(rows, key)
		if err != nil {
			failure = errors.Join(failure, ErrSliceStorageUnavailable)
			continue
		}
		result = append(result, *item)
	}
	return result, errors.Join(failure, rows.Err())
}

type SliceClearRequest struct {
	ID          string
	OrgID       int64
	RequestedBy int64
	StorageID   string
	RequestedAt time.Time
	FinishedAt  *time.Time
	ErrorCode   *string
}

func RequestSliceClear(ctx context.Context, tx pgx.Tx, orgID, userID int64, storageID string) (SliceClearRequest, error) {
	if err := setSliceActor(ctx, tx, userID); err != nil {
		return SliceClearRequest{}, err
	}
	id := uuid.NewString()
	_, err := tx.Exec(ctx, `INSERT INTO public.workspace_slice_clear_requests(id,org_id,requested_by,storage_id)
		VALUES($1::uuid,$2,$3,$4::uuid) ON CONFLICT (storage_id) WHERE finished_at IS NULL DO NOTHING`, id, orgID, userID, storageID)
	if err != nil {
		return SliceClearRequest{}, err
	}
	return LatestSliceClear(ctx, tx, orgID, storageID)
}

func LatestSliceClear(ctx context.Context, tx pgx.Tx, orgID int64, storageID string) (SliceClearRequest, error) {
	var request SliceClearRequest
	err := tx.QueryRow(ctx, `SELECT id::text,COALESCE(org_id,0),requested_by,storage_id::text,requested_at,finished_at,error_code
		FROM public.workspace_slice_clear_requests WHERE org_id=$1 AND storage_id=$2::uuid ORDER BY requested_at DESC LIMIT 1`, orgID, storageID).
		Scan(&request.ID, &request.OrgID, &request.RequestedBy, &request.StorageID, &request.RequestedAt, &request.FinishedAt, &request.ErrorCode)
	return request, err
}

func PendingSliceClears(ctx context.Context, tx pgx.Tx) ([]SliceClearRequest, error) {
	rows, err := tx.Query(ctx, `SELECT id::text,COALESCE(org_id,0),requested_by,storage_id::text,requested_at,finished_at,error_code FROM public.workspace_slice_clear_requests WHERE finished_at IS NULL ORDER BY requested_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var requests []SliceClearRequest
	for rows.Next() {
		var item SliceClearRequest
		if err := rows.Scan(&item.ID, &item.OrgID, &item.RequestedBy, &item.StorageID, &item.RequestedAt, &item.FinishedAt, &item.ErrorCode); err != nil {
			return nil, err
		}
		requests = append(requests, item)
	}
	return requests, rows.Err()
}
