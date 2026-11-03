package repo

import (
	"context"
	"encoding/json"
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

const pendingProductMutationSQL = `
SELECT NOT EXISTS (
    SELECT 1 FROM seller_upstream_writes
    WHERE org_id=$1 AND store_id=$2 AND idempotency_key=$3
) AND EXISTS (
    SELECT 1 FROM seller_upstream_writes w
    WHERE w.org_id=$1 AND w.store_id=$2 AND w.kind='product_mutation'
      AND w.request_body->>'kind'=$5
      AND w.state IN ('dispatching','result_unknown')
      AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(w.request_body->'items') prior,
                        jsonb_array_elements($4::jsonb->'items') next
          WHERE (prior->>'product_id'=next->>'product_id'
             OR NULLIF(btrim(prior->>'offer_id'),'')=NULLIF(btrim(next->>'offer_id'),''))
            AND ($5='price' OR prior->>'warehouse_id'=next->>'warehouse_id')
      )
)`

const pendingPriceMutationSQL = `
SELECT NOT EXISTS (
    SELECT 1 FROM seller_upstream_writes
    WHERE org_id=$1 AND store_id=$2 AND idempotency_key=$3
) AND EXISTS (
    SELECT 1 FROM seller_upstream_writes w
    WHERE w.org_id=$1 AND w.store_id=$2 AND w.kind='product_mutation'
      AND w.request_body->>'kind' IN ('price','promotion_join','promotion_leave')
      AND w.state IN ('dispatching','result_unknown')
      AND (
          EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(
                  jsonb_path_query_array(w.request_body,'$.items[*].product_id') ||
                  jsonb_path_query_array(w.request_body,'$.product_ids[*]') ||
                  jsonb_path_query_array(w.request_body,'$.exit_prices[*].product_id')
              ) prior, jsonb_array_elements_text(
                  jsonb_path_query_array($4::jsonb,'$.items[*].product_id') ||
                  jsonb_path_query_array($4::jsonb,'$.product_ids[*]') ||
                  jsonb_path_query_array($4::jsonb,'$.exit_prices[*].product_id')
              ) next WHERE prior.value=next.value
          ) OR EXISTS (
              SELECT 1 FROM jsonb_path_query(w.request_body,'$.items[*].offer_id') prior,
                            jsonb_path_query($4::jsonb,'$.items[*].offer_id') next
              WHERE NULLIF(btrim(prior #>> '{}'),'')=NULLIF(btrim(next #>> '{}'),'')
          )
      )
)`

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
    reconcile_after = clock_timestamp() + make_interval(secs => $7::int),
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
	if kind == contract.KindProductMutation {
		var request struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(body, &request); err != nil {
			return contract.LedgerRow{}, mapDB(err, false)
		}
		if request.Kind == "price" || request.Kind == "stock" || request.Kind == "promotion_join" || request.Kind == "promotion_leave" {
			family := "price"
			query := pendingPriceMutationSQL
			args := []any{orgID, storePK, key, string(body)}
			if request.Kind == "stock" {
				family, query = "stock", pendingProductMutationSQL
				args = append(args, request.Kind)
			}
			// New operation IDs must not bypass an unresolved write to the same target.
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('ops-' || $3::text || ':' || $1::bigint::text || ':' || $2::bigint::text,0))`, orgID, storePK, family); err != nil {
				return contract.LedgerRow{}, mapDB(err, false)
			}
			var pending bool
			if err := tx.QueryRow(ctx, query, args...).Scan(&pending); err != nil {
				return contract.LedgerRow{}, mapDB(err, false)
			}
			if pending {
				message := "该商品有尚未确认的价格或活动修改，请先核对原操作"
				if request.Kind == "stock" {
					message = "该商品仓库有尚未确认的库存修改，请先核对原操作"
				}
				return contract.LedgerRow{}, &contract.Fail{Status: 409, Code: contract.CodeSellerUnknown, Message: message}
			}
		}
	}
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
