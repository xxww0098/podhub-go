package repo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

const insertSQL = `
INSERT INTO seller_upstream_writes
    (org_id, store_id, idempotency_key, request_hash, kind, request_body)
VALUES ($1, $2, $3, $4, $5, $6::jsonb)
ON CONFLICT (org_id, store_id, idempotency_key) DO NOTHING
RETURNING id::text`

const readSQL = `
SELECT request_hash, state, response_status, response_body
FROM seller_upstream_writes
WHERE org_id = $1 AND store_id = $2 AND idempotency_key = $3`

const settleSQL = `
UPDATE seller_upstream_writes
SET state = 'settled',
    response_status = $5,
    response_content_type = 'application/json',
    response_retry_after = NULL,
    response_body = $6,
    error_code = NULL,
    error_message = NULL,
    reconcile_after = NULL,
    updated_at = clock_timestamp()
WHERE org_id = $1 AND store_id = $2 AND idempotency_key = $3
  AND request_hash = $4 AND state = 'dispatching'`

const unknownSQL = `
UPDATE seller_upstream_writes
SET state = 'result_unknown',
    error_code = $5,
    error_message = $6,
    reconcile_after = clock_timestamp() + ($7::text || ' seconds')::interval,
    updated_at = clock_timestamp()
WHERE org_id = $1 AND store_id = $2 AND idempotency_key = $3
  AND request_hash = $4 AND state = 'dispatching'`

const beatSQL = `
UPDATE seller_upstream_writes
SET heartbeat_at_ms = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
WHERE org_id = $1 AND store_id = $2 AND idempotency_key = $3
  AND state = 'dispatching'`

func (s *Store) Begin(ctx context.Context, orgID, storePK int64, key, hash, kind string, body []byte) (contract.LedgerRow, error) {
	tx, err := tenantx.BeginApp(ctx, s.Pool.Begin, orgID)
	if err != nil {
		return contract.LedgerRow{}, mapDB(err, false)
	}
	defer tx.Rollback(ctx)
	var id string
	err = tx.QueryRow(ctx, insertSQL, orgID, storePK, key, hash, kind, string(body)).Scan(&id)
	if err == nil {
		if err := tx.Commit(ctx); err != nil {
			return contract.LedgerRow{}, mapDB(err, false)
		}
		return contract.LedgerRow{Inserted: true, State: "dispatching"}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return contract.LedgerRow{}, mapDB(err, false)
	}
	var gotHash, state string
	var status *int
	var resp []byte
	if err := tx.QueryRow(ctx, readSQL, orgID, storePK, key).Scan(&gotHash, &state, &status, &resp); err != nil {
		return contract.LedgerRow{}, mapDB(err, false)
	}
	if err := tx.Commit(ctx); err != nil {
		return contract.LedgerRow{}, mapDB(err, false)
	}
	if gotHash != hash {
		return contract.LedgerRow{}, &contract.Fail{Status: 409, Code: contract.CodeConflict, Message: contract.MsgKeyBound}
	}
	row := contract.LedgerRow{State: state, Body: resp}
	if status != nil {
		row.Status = *status
	}
	return row, nil
}

func (s *Store) Settle(ctx context.Context, orgID, storePK int64, key, hash string, status int, body []byte) error {
	return s.exec(ctx, orgID, settleSQL, orgID, storePK, key, hash, status, body)
}

func (s *Store) MarkUnknown(ctx context.Context, orgID, storePK int64, key, hash, code, message string, backoffSec int) error {
	return s.exec(ctx, orgID, unknownSQL, orgID, storePK, key, hash, code, message, backoffSec)
}

func (s *Store) Heartbeat(ctx context.Context, orgID, storePK int64, key string) error {
	return s.exec(ctx, orgID, beatSQL, orgID, storePK, key)
}

func (s *Store) exec(ctx context.Context, orgID int64, sql string, args ...any) error {
	tx, err := tenantx.BeginApp(ctx, s.Pool.Begin, orgID)
	if err != nil {
		return mapDB(err, false)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return mapDB(err, false)
	}
	if err := tx.Commit(ctx); err != nil {
		return mapDB(err, false)
	}
	return nil
}
