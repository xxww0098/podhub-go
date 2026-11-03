package mediarepo

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var ErrSliceBucketNameInUse = errors.New("workspace bucket name is already reserved")

type SliceProvision struct {
	ID         string `json:"id"`
	AccountID  string `json:"account_id"`
	Bucket     string `json:"bucket"`
	Phase      string `json:"phase"`
	ErrorCode  string `json:"error_code"`
	CustomName bool   `json:"-"`
}

func ReadSliceProvision(ctx context.Context, tx pgx.Tx, orgID int64) (*SliceProvision, error) {
	var p SliceProvision
	err := tx.QueryRow(ctx, `SELECT id::text,account_id,bucket,phase,error_code,custom_name FROM workspace_slice_provisions WHERE org_id=$1`, orgID).
		Scan(&p.ID, &p.AccountID, &p.Bucket, &p.Phase, &p.ErrorCode, &p.CustomName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &p, err
}

func ReserveSliceProvision(ctx context.Context, tx pgx.Tx, orgID, userID int64, accountID, bucket string) (*SliceProvision, bool, error) {
	if err := setSliceActor(ctx, tx, userID); err != nil {
		return nil, false, err
	}
	id := uuid.NewString()
	customName := bucket != ""
	if !customName {
		bucket = "podhub-" + strings.ReplaceAll(id, "-", "")
	}
	tag, err := tx.Exec(ctx, `INSERT INTO workspace_slice_provisions(org_id,id,created_by,account_id,bucket,phase,custom_name)
		VALUES($1,$2::uuid,$3,$4,$5,'creating',$6) ON CONFLICT(org_id) DO NOTHING`, orgID, id, userID, accountID, bucket, customName)
	if err != nil {
		var conflict *pgconn.PgError
		if errors.As(err, &conflict) && conflict.ConstraintName == "workspace_slice_provisions_account_bucket_key" {
			return nil, false, ErrSliceBucketNameInUse
		}
		return nil, false, err
	}
	p, err := ReadSliceProvision(ctx, tx, orgID)
	return p, tag.RowsAffected() == 1, err
}

// Only a confirmed creation rejection may release a custom name for another attempt.
func DiscardRejectedSliceProvision(ctx context.Context, tx pgx.Tx, orgID, userID int64, id string) error {
	if err := setSliceActor(ctx, tx, userID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM workspace_slice_provisions WHERE org_id=$1 AND id=$2::uuid AND custom_name AND phase='blocked'`, orgID, id)
	if err == nil && tag.RowsAffected() != 1 {
		return ErrSliceStorageUnavailable
	}
	return err
}

func SetSliceProvision(ctx context.Context, tx pgx.Tx, orgID, userID int64, phase, code string) error {
	if err := setSliceActor(ctx, tx, userID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE workspace_slice_provisions SET phase=$2,error_code=$3,updated_at=clock_timestamp() WHERE org_id=$1`, orgID, phase, code)
	if err == nil && tag.RowsAffected() != 1 {
		return ErrSliceStorageUnavailable
	}
	return err
}

func CandidateSliceStorage(ctx context.Context, tx pgx.Tx, orgID int64, id string, key []byte) (*SliceStorage, error) {
	return scanSliceStorage(tx.QueryRow(ctx, `SELECT id::text,COALESCE(org_id,0),created_by,endpoint,bucket,public_base_url,access_key_hint,secret_nonce,secret_ciphertext,clear_at_minute,clear_configured_at
		FROM workspace_slice_storage WHERE org_id=$1 AND id=$2::uuid`, orgID, id), key)
}
