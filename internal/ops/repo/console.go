package repo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
	"github.com/xxww0098/podhub-go/internal/ops/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

const rosterSQL = `
SELECT s.id, s.uuid::text, s.name, s.create_order, COALESCE(s.client_id, ''),
       s.manual_disabled, s.quota_suspended, s.credential_revision, s.revision,
       s.assignee_membership_id,
       COALESCE(am.display_name, ''), COALESCE(au.email, ''),
       EXISTS (SELECT 1 FROM store_seller_credentials c WHERE c.store_id = s.id)
FROM organization_stores s
LEFT JOIN organization_members am ON am.id = s.assignee_membership_id
LEFT JOIN account_users au ON au.id = am.user_id
WHERE s.org_id = $1 AND s.deleted_at_ms IS NULL
ORDER BY s.create_order`

const metaSQL = `
SELECT COALESCE(o.store_limit_override, 1),
       (SELECT count(*) FROM organization_stores WHERE org_id = $1 AND deleted_at_ms IS NULL),
       (SELECT count(*) FROM organization_stores WHERE org_id = $1 AND deleted_at_ms IS NULL AND quota_suspended)
FROM organizations o WHERE o.id = $1`

func (s *Store) Roster(ctx context.Context, orgID, userID int64, role string) ([]contract.StoreHead, contract.RosterMeta, error) {
	var meta contract.RosterMeta
	if err := s.Pool.QueryRow(ctx, metaSQL, orgID).Scan(&meta.StoreLimit, &meta.StoresUsed, &meta.Suspended); err != nil {
		return nil, meta, mapDB(err, true)
	}
	var member *int64
	_ = s.Pool.QueryRow(ctx, `
		SELECT id FROM organization_members
		WHERE org_id = $1 AND user_id = $2 AND status = 'active' AND NOT manual_disabled AND NOT quota_suspended`,
		orgID, userID).Scan(&member)
	rows, err := s.Pool.Query(ctx, rosterSQL, orgID)
	if err != nil {
		return nil, meta, mapDB(err, true)
	}
	defer rows.Close()
	manage := access.CanManage(role)
	var out []contract.StoreHead
	for rows.Next() {
		var h contract.StoreHead
		if err := rows.Scan(&h.PK, &h.UUID, &h.Name, &h.CreateOrder, &h.ClientID, &h.ManualDisabled, &h.QuotaSuspended, &h.CredentialRev, &h.Revision, &h.AssigneeID, &h.AssigneeName, &h.AssigneeEmail, &h.Configured); err != nil {
			return nil, meta, mapDB(err, true)
		}
		if !manage && (member == nil || h.AssigneeID == nil || *h.AssigneeID != *member) {
			continue
		}
		h.CanManage = manage
		out = append(out, h)
	}
	if out == nil {
		out = []contract.StoreHead{}
	}
	return out, meta, rows.Err()
}

func (s *Store) Ledger(ctx context.Context, orgID int64, cap int) ([]contract.LedgerEntry, error) {
	tx, err := tenantx.BeginApp(ctx, s.Pool.Begin, orgID)
	if err != nil {
		return nil, mapDB(err, false)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, domain.LedgerSQL, orgID, cap)
	if err != nil {
		return nil, mapDB(err, false)
	}
	defer rows.Close()
	var out []contract.LedgerEntry
	for rows.Next() {
		var e contract.LedgerEntry
		var created, updated time.Time
		if err := rows.Scan(&e.Kind, &e.Status, &created, &updated); err != nil {
			return nil, mapDB(err, false)
		}
		e.CreatedMS = created.UnixMilli()
		e.UpdatedMS = updated.UnixMilli()
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDB(err, false)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDB(err, false)
	}
	if out == nil {
		out = []contract.LedgerEntry{}
	}
	return out, nil
}

const metricsSQL = `
SELECT store_id::text, ordered_units_30d, previous_ordered_units_30d, day_series_14d, through_day,
       last_sync_at_ms, last_error, retry_at_ms
FROM console_store_metrics
WHERE org_id = $1 AND store_id = ANY($2::uuid[])
ORDER BY store_id`

func (s *Store) Metrics(ctx context.Context, orgID int64, stores []string) ([]contract.MetricRow, error) {
	if len(stores) == 0 {
		return []contract.MetricRow{}, nil
	}
	return inTenant(ctx, s, orgID, func(tx pgx.Tx) ([]contract.MetricRow, error) {
		rows, err := tx.Query(ctx, metricsSQL, orgID, stores)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []contract.MetricRow
		for rows.Next() {
			var m contract.MetricRow
			var errText *string
			var through *string
			if err := rows.Scan(&m.StoreID, &m.Ordered, &m.Previous, &m.DaySeries, &through, &m.LastSyncMS, &errText, &m.RetryAtMS); err != nil {
				return nil, err
			}
			if through != nil {
				m.ThroughDay = *through
			}
			if errText != nil {
				m.LastError = *errText
			}
			if m.DaySeries == nil {
				m.DaySeries = []float64{}
			}
			out = append(out, m)
		}
		return out, rows.Err()
	})
}

const productsSQL = `
SELECT v.store_id::text, s.count_total, s.count_on_sale, s.count_hidden,
       s.count_moderation_failed, s.count_zero_stock, s.count_archived,
       s.last_full_sync_at_ms, COALESCE(s.pass, ''), COALESCE(s.hold, ''),
       s.hold_until_ms, COALESCE(s.hold_reason, ''),
       (SELECT MAX(GREATEST(COALESCE(p.refreshed_at_ms, 0), COALESCE(p.evidence_at_ms, 0)))
          FROM store_products p
         WHERE p.org_id = $1 AND p.store_pk = st.id AND p.gone_at_ms IS NULL)
FROM unnest($2::uuid[]) AS v(store_id)
JOIN organization_stores st ON st.org_id = $1 AND st.uuid = v.store_id
LEFT JOIN store_product_sync s ON s.org_id = $1 AND s.store_id = v.store_id
ORDER BY v.store_id`

func (s *Store) Products(ctx context.Context, orgID int64, stores []string) ([]contract.ProductRow, error) {
	if len(stores) == 0 {
		return []contract.ProductRow{}, nil
	}
	return inTenantProducts(ctx, s, orgID, stores)
}

func inTenantProducts(ctx context.Context, s *Store, orgID int64, stores []string) ([]contract.ProductRow, error) {
	tx, err := tenantx.BeginApp(ctx, s.Pool.Begin, orgID)
	if err != nil {
		return nil, mapDB(err, false)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, productsSQL, orgID, stores)
	if err != nil {
		return nil, mapDB(err, false)
	}
	defer rows.Close()
	var out []contract.ProductRow
	for rows.Next() {
		var p contract.ProductRow
		if err := rows.Scan(&p.StoreID, &p.CountTotal, &p.CountOnSale, &p.CountHidden, &p.CountModerationFailed, &p.CountZeroStock, &p.CountArchived, &p.LastFullSync, &p.Pass, &p.Hold, &p.HoldUntilMS, &p.HoldReason, &p.PricedAtMS); err != nil {
			return nil, mapDB(err, false)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDB(err, false)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDB(err, false)
	}
	if out == nil {
		out = []contract.ProductRow{}
	}
	return out, nil
}

func inTenant(ctx context.Context, s *Store, orgID int64, fn func(pgx.Tx) ([]contract.MetricRow, error)) ([]contract.MetricRow, error) {
	tx, err := tenantx.BeginApp(ctx, s.Pool.Begin, orgID)
	if err != nil {
		return nil, mapDB(err, false)
	}
	defer tx.Rollback(ctx)
	out, err := fn(tx)
	if err != nil {
		return nil, mapDB(err, false)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDB(err, false)
	}
	if out == nil {
		out = []contract.MetricRow{}
	}
	return out, nil
}

const unknownSQLList = `
SELECT w.id::text, w.store_id, s.uuid::text, w.idempotency_key, w.kind,
       w.request_body, w.probe_pass_count, w.last_observation
FROM seller_upstream_writes w
JOIN organization_stores s ON s.id = w.store_id AND s.org_id = w.org_id
WHERE w.org_id = $1 AND w.state = 'result_unknown'
  AND s.deleted_at_ms IS NULL AND s.uuid = ANY($2::uuid[])
ORDER BY w.updated_at ASC, w.id ASC
LIMIT $3`

func (s *Store) ListUnknown(ctx context.Context, orgID int64, stores []string, limit int) ([]contract.UnknownWrite, error) {
	if len(stores) == 0 {
		return []contract.UnknownWrite{}, nil
	}
	tx, err := tenantx.BeginApp(ctx, s.Pool.Begin, orgID)
	if err != nil {
		return nil, mapDB(err, false)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, unknownSQLList, orgID, stores, limit)
	if err != nil {
		return nil, mapDB(err, false)
	}
	defer rows.Close()
	var out []contract.UnknownWrite
	for rows.Next() {
		var u contract.UnknownWrite
		if err := rows.Scan(&u.ID, &u.StorePK, &u.StoreUUID, &u.Key, &u.Kind, &u.Body, &u.Passes, &u.LastObservation); err != nil {
			return nil, mapDB(err, false)
		}
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDB(err, false)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDB(err, false)
	}
	if out == nil {
		out = []contract.UnknownWrite{}
	}
	return out, nil
}

const applySQL = `
UPDATE seller_upstream_writes
SET state = $3,
    last_observation = to_jsonb($4::text),
    probe_pass_count = probe_pass_count + 1,
    error_code = NULLIF($5, ''),
    error_message = $6,
    reconcile_after = CASE
        WHEN $3 = 'result_unknown'
        THEN clock_timestamp() + ($7::text || ' seconds')::interval
        ELSE NULL
    END,
    updated_at = clock_timestamp()
WHERE org_id = $1 AND id = $2::uuid AND state = 'result_unknown'`

func (s *Store) ApplyProbe(ctx context.Context, orgID int64, id, state, observation, errCode, message string, backoffSec int) error {
	return s.exec(ctx, orgID, applySQL, orgID, id, state, observation, errCode, message, backoffSec)
}

const lockSQL = `SELECT pg_try_advisory_xact_lock(hashtext('console_metrics:' || $1::text))`

const dueSQL = `
SELECT store_id::text, last_sync_at_ms, retry_at_ms
FROM console_store_metrics
WHERE org_id = $1 AND store_id = ANY($2::uuid[])`

const upsertOK = `
INSERT INTO console_store_metrics (
    org_id, store_id, refresh_generation, ordered_units_30d,
    previous_ordered_units_30d, day_series_14d, through_day,
    last_sync_at_ms, last_error, retry_at_ms
)
VALUES ($1, $2::uuid, $3, $4, NULL, $5, $6, $7, NULL, NULL)
ON CONFLICT (store_id) DO UPDATE SET
    refresh_generation = EXCLUDED.refresh_generation,
    ordered_units_30d = EXCLUDED.ordered_units_30d,
    previous_ordered_units_30d = CASE
        WHEN console_store_metrics.through_day = EXCLUDED.through_day
            THEN console_store_metrics.previous_ordered_units_30d
        ELSE console_store_metrics.ordered_units_30d
    END,
    day_series_14d = EXCLUDED.day_series_14d,
    through_day = EXCLUDED.through_day,
    last_sync_at_ms = EXCLUDED.last_sync_at_ms,
    last_error = NULL,
    retry_at_ms = NULL
WHERE console_store_metrics.refresh_generation < EXCLUDED.refresh_generation
  AND COALESCE(console_store_metrics.through_day, '') <= EXCLUDED.through_day`

const upsertFail = `
INSERT INTO console_store_metrics (
    org_id, store_id, refresh_generation, last_error, retry_at_ms
)
VALUES ($1, $2::uuid, $3, $4, $5)
ON CONFLICT (store_id) DO UPDATE SET
    refresh_generation = EXCLUDED.refresh_generation,
    last_error = EXCLUDED.last_error,
    retry_at_ms = EXCLUDED.retry_at_ms
WHERE console_store_metrics.refresh_generation < EXCLUDED.refresh_generation`

func (s *Store) Refresh(ctx context.Context, orgID int64, stores []string, nowMS int64, pull func(storeID string) (float64, []float64, string, int64, string, *int64, error)) ([]contract.RefreshResult, []contract.MetricRow, error) {
	tx, err := tenantx.BeginApp(ctx, s.Pool.Begin, orgID)
	if err != nil {
		return nil, nil, mapDB(err, false)
	}
	defer tx.Rollback(ctx)
	var locked bool
	if err := tx.QueryRow(ctx, lockSQL, orgID).Scan(&locked); err != nil {
		return nil, nil, mapDB(err, false)
	}
	if !locked {
		return nil, nil, &contract.Fail{Status: 409, Code: contract.CodeRefreshBusy, Message: contract.MsgRefreshBusy}
	}
	due := map[string]struct{}{}
	for _, id := range stores {
		due[id] = struct{}{}
	}
	if len(stores) > 0 {
		rows, err := tx.Query(ctx, dueSQL, orgID, stores)
		if err != nil {
			return nil, nil, mapDB(err, false)
		}
		for rows.Next() {
			var id string
			var last, retry *int64
			if err := rows.Scan(&id, &last, &retry); err != nil {
				rows.Close()
				return nil, nil, mapDB(err, false)
			}
			if !domain.MetricsRefreshDue(last, retry, nowMS) {
				delete(due, id)
			}
		}
		rows.Close()
	}
	gen := nowMS
	if gen < 1 {
		gen = 1
	}
	var results []contract.RefreshResult
	for id := range due {
		ordered, days, through, syncMS, fail, retry, pullErr := pull(id)
		results = append(results, contract.RefreshResult{StoreID: id, Failed: pullErr != nil, Error: fail})
		if pullErr != nil {
			if _, err := tx.Exec(ctx, upsertFail, orgID, id, gen, fail, retry); err != nil {
				return nil, nil, mapDB(err, false)
			}
			continue
		}
		series := last14(days)
		if _, err := tx.Exec(ctx, upsertOK, orgID, id, gen, ordered, series, through, syncMS); err != nil {
			return nil, nil, mapDB(err, false)
		}
	}
	if results == nil {
		results = []contract.RefreshResult{}
	}
	metrics, err := s.metricsTx(ctx, tx, orgID, stores)
	if err != nil {
		return nil, nil, mapDB(err, false)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, mapDB(err, false)
	}
	return results, metrics, nil
}

func last14(days []float64) []float64 {
	if len(days) <= 14 {
		out := make([]float64, 14)
		copy(out[14-len(days):], days)
		return out
	}
	return days[len(days)-14:]
}

func (s *Store) metricsTx(ctx context.Context, tx pgx.Tx, orgID int64, stores []string) ([]contract.MetricRow, error) {
	if len(stores) == 0 {
		return []contract.MetricRow{}, nil
	}
	rows, err := tx.Query(ctx, metricsSQL, orgID, stores)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []contract.MetricRow
	for rows.Next() {
		var m contract.MetricRow
		var errText, through *string
		if err := rows.Scan(&m.StoreID, &m.Ordered, &m.Previous, &m.DaySeries, &through, &m.LastSyncMS, &errText, &m.RetryAtMS); err != nil {
			return nil, err
		}
		if through != nil {
			m.ThroughDay = *through
		}
		if errText != nil {
			m.LastError = *errText
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
