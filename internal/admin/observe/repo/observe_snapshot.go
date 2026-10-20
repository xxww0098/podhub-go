package observerepo

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	observecontract "github.com/xxww0098/podhub-go/internal/admin/observe/contract"
	"github.com/xxww0098/podhub-go/internal/admin/observe/domain"
)

func storeIDs(stores []obsStore) []string {
	out := make([]string, 0, len(stores))
	for _, store := range stores {
		out = append(out, store.StoreID)
	}
	return out
}

type rosterStore struct {
	ID                    string          `json:"id"`
	Label                 string          `json:"label"`
	ClientID              string          `json:"client_id"`
	WatermarkName         string          `json:"watermark_name"`
	AdvertisingClientID   string          `json:"advertising_client_id"`
	RefID                 string          `json:"ref_id"`
	AdvertisingConfigured bool            `json:"advertising_configured"`
	Configured            bool            `json:"configured"`
	Active                bool            `json:"active"`
	NeedsReentry          bool            `json:"needs_reentry"`
	CanManage             bool            `json:"can_manage"`
	CanEditCredential     bool            `json:"can_edit_credential"`
	AssigneeKeyManage     bool            `json:"assignee_key_manage"`
	SecretStatus          string          `json:"secret_status"`
	UpdatedAtMS           int64           `json:"updated_at_ms"`
	CredentialRevision    *int64          `json:"credential_revision"`
	VerifiedAtMS          *int64          `json:"verified_at_ms"`
	LastUsedAtMS          *int64          `json:"last_used_at_ms"`
	AssigneeMembershipID  *int64          `json:"assignee_membership_id"`
	CloudStoreUUID        string          `json:"cloud_store_uuid"`
	CloudStatus           string          `json:"cloud_status"`
	ManualDisabled        bool            `json:"manual_disabled"`
	QuotaSuspended        bool            `json:"quota_suspended"`
	AssigneeName          *string         `json:"assignee_name,omitempty"`
	Permissions           map[string]bool `json:"permissions"`
}

func projectRoster(stores []obsStore) (any, int) {
	views := make([]rosterStore, 0, len(stores))
	suspended := 0
	for _, store := range stores {
		if store.Quota {
			suspended++
		}
		views = append(views, rosterStore{
			ID: store.StoreName, Label: store.StoreName, SecretStatus: "unavailable",
			CloudStoreUUID: store.StoreID, CloudStatus: domain.StoreStatus(store.Manual, store.Quota),
			ManualDisabled: store.Manual, QuotaSuspended: store.Quota, AssigneeName: store.Assignee,
			Permissions: map[string]bool{},
		})
	}
	return struct {
		Stores     []rosterStore `json:"stores"`
		ActiveID   *string       `json:"active_id"`
		StoreLimit *int64        `json:"store_limit"`
		StoresUsed int           `json:"stores_used"`
		Suspended  int           `json:"suspended"`
	}{views, nil, nil, len(stores), suspended}, suspended
}

type consoleMetric struct {
	StoreID                string  `json:"store_id"`
	OrderedUnits30d        *int64  `json:"ordered_units_30d,omitempty"`
	PreviousOrderedUnits30 *int64  `json:"previous_ordered_units_30d,omitempty"`
	DaySeries14d           any     `json:"day_series_14d,omitempty"`
	ThroughDay             *string `json:"through_day,omitempty"`
	LastSyncAtMS           *int64  `json:"last_sync_at_ms,omitempty"`
	LastError              *string `json:"last_error,omitempty"`
	RetryAtMS              *int64  `json:"retry_at_ms,omitempty"`
}

type consoleProducts struct {
	StoreID               string  `json:"store_id"`
	CountTotal            *int64  `json:"count_total,omitempty"`
	CountOnSale           *int64  `json:"count_on_sale,omitempty"`
	CountHidden           *int64  `json:"count_hidden,omitempty"`
	CountModerationFailed *int64  `json:"count_moderation_failed,omitempty"`
	CountZeroStock        *int64  `json:"count_zero_stock,omitempty"`
	CountArchived         *int64  `json:"count_archived,omitempty"`
	LastFullSyncAtMS      *int64  `json:"last_full_sync_at_ms,omitempty"`
	PricedAtMSMax         *int64  `json:"priced_at_ms_max,omitempty"`
	Pass                  *bool   `json:"pass,omitempty"`
	Hold                  *bool   `json:"hold,omitempty"`
	HoldUntilMS           *int64  `json:"hold_until_ms,omitempty"`
	HoldReason            *string `json:"hold_reason,omitempty"`
}

const ledgerSQL = `
WITH ledger AS (
 SELECT 'listing' AS kind,
        CASE i.state WHEN 'submitting' THEN 'dispatching' WHEN 'unknown' THEN 'result_unknown'
          WHEN 'accepted' THEN 'succeeded' WHEN 'rejected' THEN 'failed' WHEN 'cancelled' THEN 'failed'
          ELSE i.state END AS status, i.created_at, i.updated_at
   FROM submission_intents i
   JOIN organizations o ON o.id = i.org_id
   JOIN organization_stores s ON s.org_id = i.org_id AND s.uuid = i.store_id
  WHERE o.dissolved_at IS NULL AND s.deleted_at_ms IS NULL
    AND ($1::bigint IS NULL OR i.org_id = $1) AND ($2::uuid IS NULL OR s.uuid = $2::uuid)
 UNION ALL
 SELECT 'write', CASE w.state WHEN 'settled' THEN 'succeeded' ELSE w.state END, w.created_at, w.updated_at
   FROM seller_upstream_writes w
   JOIN organizations o ON o.id = w.org_id
   JOIN organization_stores s ON s.org_id = w.org_id AND s.id = w.store_id
  WHERE o.dissolved_at IS NULL AND s.deleted_at_ms IS NULL
    AND ($1::bigint IS NULL OR w.org_id = $1) AND ($2::uuid IS NULL OR s.uuid = $2::uuid)
), normalized AS (
 SELECT kind, CASE WHEN status IN ('recorded','queued') THEN 'queued'
   WHEN status IN ('dispatching','succeeded','failed','result_unknown','reconciled','conflict','operator_attested') THEN status
   ELSE 'unknown' END AS status, created_at, updated_at,
   (created_at AT TIME ZONE 'UTC')::date AS created_day,
   (updated_at AT TIME ZONE 'UTC')::date AS updated_day
   FROM ledger
), facts AS (
 SELECT *, status IN ('succeeded','reconciled') AS proven,
   status IN ('succeeded','reconciled','operator_attested') AS settled,
   status IN ('succeeded','reconciled','operator_attested','failed','conflict') AS terminal,
   status IN ('failed','conflict','result_unknown','unknown') AS actionable
   FROM normalized
), clock AS (SELECT to_timestamp($3::double precision / 1000) AS now_at),
calendar AS (SELECT (now_at AT TIME ZONE 'UTC')::date AS today FROM clock),
summary AS (
 SELECT count(*) AS total,
   count(*) FILTER (WHERE kind='listing' AND created_day BETWEEN today-6 AND today) AS created7,
   count(*) FILTER (WHERE kind='listing' AND settled AND updated_day BETWEEN today-6 AND today) AS settled7,
   count(*) FILTER (WHERE status IN ('queued','dispatching')) AS active,
   count(*) FILTER (WHERE proven) AS proven_count,
   count(*) FILTER (WHERE status IN ('failed','conflict')) AS failed,
   count(*) FILTER (WHERE status IN ('result_unknown','unknown')) AS unknown,
   count(*) FILTER (WHERE status='operator_attested') AS attested,
   count(*) FILTER (WHERE actionable) AS needs_action,
   min(updated_at) FILTER (WHERE actionable) AS oldest_action,
   percentile_cont(0.5) WITHIN GROUP (ORDER BY greatest(0, extract(epoch FROM updated_at-created_at)/60))
     FILTER (WHERE terminal) AS median_minutes
   FROM facts CROSS JOIN calendar
), intake AS (SELECT created_day AS day, count(*) AS n FROM facts WHERE kind='listing' GROUP BY created_day),
settlements AS (SELECT updated_day AS day, count(*) AS n FROM facts WHERE kind='listing' AND settled GROUP BY updated_day),
exceptions AS (SELECT updated_day AS day, count(*) AS n FROM facts WHERE actionable GROUP BY updated_day),
days AS (SELECT today-n AS day FROM calendar CROSS JOIN generate_series(0,13) AS n),
series AS (
 SELECT jsonb_agg(jsonb_build_object('day',to_char(d.day,'YYYY-MM-DD'), 'intake',coalesce(i.n,0),
   'settled',coalesce(s.n,0), 'exceptions',coalesce(e.n,0)) ORDER BY d.day) AS value
   FROM days d LEFT JOIN intake i ON i.day=d.day LEFT JOIN settlements s ON s.day=d.day LEFT JOIN exceptions e ON e.day=d.day
)
SELECT jsonb_build_object('total', total, 'createdIn7Days', created7, 'settledIn7Days', settled7,
 'inFlight', active, 'provenSuccessRate', 100.0*proven_count/nullif(proven_count+failed,0),
 'medianSettlementMinutes', median_minutes, 'needsAction', needs_action,
 'oldestActionHours', CASE WHEN oldest_action IS NULL THEN NULL ELSE greatest(0, extract(epoch FROM now_at-oldest_action)/3600) END,
 'series', series.value, 'outcomes', jsonb_build_object('settled', proven_count, 'active', active,
  'unknown', unknown, 'failed', failed, 'attested', attested)) AS value
  FROM summary CROSS JOIN series CROSS JOIN clock`

func (r *Observe) Snapshot(ctx context.Context, actor corecontract.Actor, scope observecontract.Scope) ([]byte, error) {
	scope, err := normalizeScope(scope)
	if err != nil {
		return nil, err
	}
	generated := r.now().UnixMilli()
	tx, err := r.beginObserve(ctx, actor)
	if err != nil {
		return nil, corerepo.MapBill(err, "internal", false)
	}
	workspaces, stores, orgID, err := loadScope(ctx, tx, scope)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, corerepo.MapBill(err, "internal", false)
	}
	ids := storeIDs(stores)
	metrics, err := loadMetrics(ctx, tx, ids)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, corerepo.MapBill(err, "internal", false)
	}
	products, err := loadConsoleProducts(ctx, tx, ids)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, corerepo.MapBill(err, "internal", false)
	}
	var storeArg any
	if scope.StoreID != "" {
		storeArg = scope.StoreID
	}
	var ledger json.RawMessage
	err = tx.QueryRow(ctx, ledgerSQL, orgID, storeArg, generated).Scan(&ledger)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, corecontract.Internal("internal", corerepo.MsgUnavailable)
	}
	if err := r.finishObserve(ctx, tx, actor, scope); err != nil {
		return nil, corerepo.MapBill(err, "internal", false)
	}
	roster, _ := projectRoster(stores)
	var total struct {
		Total int `json:"total"`
	}
	_ = json.Unmarshal(ledger, &total)
	if err := r.auditObserve(ctx, actor, scopeOrg(workspaces, scope), entityOf(scope), "/api/admin/ops/console/snapshot", "observation_console", scope, len(workspaces), len(stores), total.Total); err != nil {
		return nil, corerepo.MapBill(err, "internal", false)
	}
	body, err := corerepo.Data(struct {
		Roster        any               `json:"roster"`
		Metrics       []consoleMetric   `json:"metrics"`
		Products      []consoleProducts `json:"products"`
		Ledger        json.RawMessage   `json:"ledger"`
		GeneratedAtMS int64             `json:"generatedAtMs"`
	}{roster, metrics, products, ledger, generated})
	return body, err
}

func loadMetrics(ctx context.Context, tx pgx.Tx, ids []string) ([]consoleMetric, error) {
	if len(ids) == 0 {
		return []consoleMetric{}, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT m.store_id::text, m.ordered_units_30d, m.previous_ordered_units_30d,
		       m.day_series_14d, m.through_day::text, m.last_sync_at_ms, m.last_error, m.retry_at_ms
		  FROM console_store_metrics m
		  JOIN organization_stores s ON s.uuid = m.store_id AND s.org_id = m.org_id
		  JOIN organizations o ON o.id = s.org_id
		 WHERE m.store_id = ANY($1::uuid[]) AND s.deleted_at_ms IS NULL AND o.dissolved_at IS NULL
		 ORDER BY m.store_id`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []consoleMetric{}
	for rows.Next() {
		var item consoleMetric
		var series []byte
		var through *string
		if err := rows.Scan(&item.StoreID, &item.OrderedUnits30d, &item.PreviousOrderedUnits30, &series, &through, &item.LastSyncAtMS, &item.LastError, &item.RetryAtMS); err != nil {
			return nil, err
		}
		if len(series) > 0 {
			item.DaySeries14d = json.RawMessage(series)
		}
		item.ThroughDay = through
		out = append(out, item)
	}
	return out, rows.Err()
}

type syncRow struct {
	StoreID         string
	Pass            *bool
	Hold            *bool
	HoldUntil       *int64
	HoldReason      *string
	LastFull        *int64
	NextDue         *int64
	ManualRequested *int64
	Failures        int
	MetricsAt       *int64
	MetricsError    *string
	Currency        *string
	CountTotal      *int64
	CountOnSale     *int64
	CountProcessing *int64
	CountHidden     *int64
	CountModeration *int64
	CountZero       *int64
	CountArchived   *int64
	CountDelisted   *int64
}

func loadSync(ctx context.Context, tx pgx.Tx, ids []string) ([]syncRow, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT sync.store_id::text, sync.pass, sync.hold, sync.hold_until_ms, sync.hold_reason,
		       sync.last_full_sync_at_ms, sync.next_due_at_ms, sync.manual_requested_at_ms,
		       sync.consecutive_failures, sync.metrics_at_ms, sync.metrics_error, sync.currency,
		       sync.count_total, sync.count_on_sale, sync.count_processing, sync.count_hidden,
		       sync.count_moderation_failed, sync.count_zero_stock, sync.count_archived, sync.count_delisted
		  FROM store_product_sync sync
		  JOIN organization_stores s ON s.uuid = sync.store_id AND s.org_id = sync.org_id
		  JOIN organizations o ON o.id = s.org_id
		 WHERE sync.store_id = ANY($1::uuid[]) AND s.deleted_at_ms IS NULL AND o.dissolved_at IS NULL`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []syncRow{}
	for rows.Next() {
		var item syncRow
		if err := rows.Scan(&item.StoreID, &item.Pass, &item.Hold, &item.HoldUntil, &item.HoldReason, &item.LastFull, &item.NextDue,
			&item.ManualRequested, &item.Failures, &item.MetricsAt, &item.MetricsError, &item.Currency, &item.CountTotal, &item.CountOnSale,
			&item.CountProcessing, &item.CountHidden, &item.CountModeration, &item.CountZero, &item.CountArchived, &item.CountDelisted); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func loadConsoleProducts(ctx context.Context, tx pgx.Tx, ids []string) ([]consoleProducts, error) {
	syncs, err := loadSync(ctx, tx, ids)
	if err != nil {
		return nil, err
	}
	priced := map[string]*int64{}
	if len(ids) > 0 {
		rows, err := tx.Query(ctx, `
			SELECT s.uuid::text, max(greatest(coalesce(p.refreshed_at_ms,0), coalesce(p.evidence_at_ms,0)))
			  FROM store_products p
			  JOIN organization_stores s ON s.id = p.store_pk AND s.org_id = p.org_id
			  JOIN organizations o ON o.id = s.org_id
			 WHERE s.uuid = ANY($1::uuid[]) AND p.gone_at_ms IS NULL AND s.deleted_at_ms IS NULL AND o.dissolved_at IS NULL
			 GROUP BY s.uuid`, ids)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			var at *int64
			if err := rows.Scan(&id, &at); err != nil {
				rows.Close()
				return nil, err
			}
			priced[id] = at
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	out := make([]consoleProducts, 0, len(syncs))
	for _, row := range syncs {
		out = append(out, consoleProducts{
			StoreID: row.StoreID, CountTotal: row.CountTotal, CountOnSale: row.CountOnSale, CountHidden: row.CountHidden,
			CountModerationFailed: row.CountModeration, CountZeroStock: row.CountZero, CountArchived: row.CountArchived,
			LastFullSyncAtMS: row.LastFull, PricedAtMSMax: priced[row.StoreID], Pass: row.Pass, Hold: row.Hold,
			HoldUntilMS: row.HoldUntil, HoldReason: row.HoldReason,
		})
	}
	return out, nil
}
