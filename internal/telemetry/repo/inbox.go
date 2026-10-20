// Package telemetryrepo writes the inbox and client listing logs.
// db/schema has no copy of these tables, so the statements stay handwritten
// next to the port. They are the SQL in spec-aomt-telemetry sections 1.4 and 4.4.
package telemetryrepo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
	"github.com/xxww0098/podhub-go/internal/telemetry/domain"
)

// Repo uses the process pool. A nil pool fails closed.
type Repo struct {
	pool *pgxpool.Pool
}

// New binds the pool.
func New(pool *pgxpool.Pool) *Repo { return &Repo{pool: pool} }

// S3MonthlyLimit is COALESCE(store_limit_override, plans.max_stores, 0)
// passed through s3_bytes_for_stores. The entitlement resolver body was not
// exported; this is the store-count expression already used for seat quota.
func (r *Repo) S3MonthlyLimit(ctx context.Context, orgID int64) (int64, error) {
	if r == nil || r.pool == nil {
		return 0, domain.Unavailable()
	}
	tx, err := r.beginAppRole(ctx)
	if err != nil {
		return 0, mapDB(err)
	}
	defer tx.Rollback(ctx)
	var stores int64
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(o.store_limit_override, p.max_stores, 0)
		  FROM organizations o
		  LEFT JOIN plans p ON p.key = o.plan
		 WHERE o.id = $1`, orgID).Scan(&stores)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, mapDB(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, mapDB(err)
	}
	return domain.S3BytesForStores(stores), nil
}

// CommitChunk is one write_under_authority transaction. Per-item failures
// stay in the chunk and commit. A lease or audit failure rolls it back.
func (r *Repo) CommitChunk(ctx context.Context, chunk domain.Chunk) (domain.ChunkOutcome, error) {
	if r == nil || r.pool == nil {
		return domain.ChunkOutcome{}, domain.Unavailable()
	}
	tx, err := r.beginAppRole(ctx)
	if err != nil {
		return domain.ChunkOutcome{}, mapDB(err)
	}
	defer tx.Rollback(ctx)
	defer writer.Forget(tx)
	if err := telemetryLease(ctx, tx, chunk.Now); err != nil {
		return domain.ChunkOutcome{}, err
	}
	owner, err := ownerUUID(ctx, tx, chunk.UserID)
	if err != nil {
		return domain.ChunkOutcome{}, mapDB(err)
	}
	out := domain.ChunkOutcome{Accepted: []string{}, Rejected: []domain.RejectedEvent{}}
	for _, ev := range chunk.Events {
		ok, reason := applyEvent(ctx, tx, chunk, ev, owner)
		if ok {
			out.Accepted = append(out.Accepted, ev.ID)
			continue
		}
		out.Rejected = append(out.Rejected, domain.RejectedEvent{ID: ev.ID, Reason: reason})
	}
	msg, err := auditMessage(len(out.Accepted), len(out.Rejected)+chunk.PreRejected)
	if err != nil {
		return domain.ChunkOutcome{}, domain.Unavailable()
	}
	leaseID, fence := writer.AuditArgs(tx)
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_logs
		    (org_id, user_id, module, entity_type, entity_id, api_method, api_path,
		     action, status, result, message, shop_id, created_at_ms, created_at,
		     actor_kind, support_grant_id, writer_lease_id, writer_fence_token)
		VALUES ($1, $2, 'telemetry', 'event_inbox', $3, 'POST', '/api/events/inbox',
		        'inbox_batch_processed', 'success', 'applied', $4, NULL,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        clock_timestamp(), 'user', NULL, $5, $6)`,
		chunk.OrgID, chunk.UserID, chunk.DeviceUID, msg, leaseID, fence)
	if err != nil {
		return domain.ChunkOutcome{}, mapDB(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.ChunkOutcome{}, mapDB(err)
	}
	return out, nil
}

// InsertClientLogs writes the batch under the tenant GUC. One failure rolls
// the whole batch back. Duplicate (user_id, client_id) pairs in the slice
// keep the first row, matching ON CONFLICT DO NOTHING against a row this
// statement would have inserted earlier.
func (r *Repo) InsertClientLogs(ctx context.Context, orgID, userID int64, rows []domain.ClientLog) error {
	if len(rows) == 0 {
		return nil
	}
	if r == nil || r.pool == nil {
		return domain.LogsNotWritten()
	}
	rows = dedupeClientLogs(userID, rows)
	err := db.InTx(ctx, r.pool, db.App(orgID), func(tx pgx.Tx) error {
		return insertClientLogBatch(ctx, tx, orgID, userID, rows)
	})
	if err != nil {
		return domain.LogsNotWritten()
	}
	return nil
}

func dedupeClientLogs(userID int64, rows []domain.ClientLog) []domain.ClientLog {
	seen := make(map[string]struct{}, len(rows))
	out := make([]domain.ClientLog, 0, len(rows))
	user := strconv.FormatInt(userID, 10)
	for _, row := range rows {
		key := user + "\x00" + row.ClientID
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, row)
	}
	return out
}

func insertClientLogBatch(ctx context.Context, tx pgx.Tx, orgID, userID int64, rows []domain.ClientLog) error {
	if len(rows) == 0 {
		return nil
	}
	var b strings.Builder
	b.WriteString(`INSERT INTO public.client_listing_logs (
		org_id, user_id, client_id, session_id, version, logged_at, level, module, event,
		duration_ms, batch_id, row_id, offer_id, intent_id, job_id, psd_id, error_code,
		error_message, fields
	) VALUES `)
	args := make([]any, 0, len(rows)*19)
	for i, row := range rows {
		if i > 0 {
			b.WriteByte(',')
		}
		base := len(args)
		b.WriteByte('(')
		for c := 0; c < 19; c++ {
			if c > 0 {
				b.WriteByte(',')
			}
			fmt.Fprintf(&b, "$%d", base+c+1)
			if c == 18 {
				b.WriteString("::jsonb")
			}
		}
		b.WriteByte(')')
		args = append(args,
			orgID, userID, row.ClientID, row.SessionID, row.Version, row.LoggedAt, row.Level, row.Module, row.Event,
			row.DurationMS, row.BatchID, row.RowID, row.OfferID, row.IntentID, row.JobID, row.PsdID, row.ErrorCode,
			row.ErrorMessage, row.Fields)
	}
	b.WriteString(` ON CONFLICT (user_id, client_id) DO NOTHING`)
	_, err := tx.Exec(ctx, b.String(), args...)
	return err
}

func (r *Repo) beginAppRole(ctx context.Context) (pgx.Tx, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('role', $1, true)", tenantx.RoleApp); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// telemetryLease is the telemetry fence. The 503 text stays WritesDisabled.
func telemetryLease(ctx context.Context, tx pgx.Tx, now time.Time) error {
	if now.IsZero() {
		now = time.Now()
	}
	_, err := writer.Assert(ctx, tx, "telemetry", writer.ProcessIdentity(), now.UnixMilli(), domain.WritesDisabled().Error())
	if writer.IsDisabled(err) {
		return domain.WritesDisabled()
	}
	return mapDB(err)
}

func ownerUUID(ctx context.Context, tx pgx.Tx, userID int64) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `SELECT public_id FROM account_users WHERE id = $1`, userID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}

func applyEvent(ctx context.Context, tx pgx.Tx, chunk domain.Chunk, ev domain.AcceptedEvent, owner string) (bool, string) {
	stored, ok, err := loadInbox(ctx, tx, chunk.DeviceUID, ev.ID)
	if err != nil {
		return false, "写入失败"
	}
	if ok {
		return finishExisting(ctx, tx, chunk, ev, stored, owner)
	}
	rows, err := domain.BillableInputs(chunk.DeviceUID, ev)
	if err != nil {
		return false, "写入失败"
	}
	if len(rows) > 0 {
		if reason := recordUsage(ctx, tx, chunk, rows, owner); reason != "" {
			return false, reason
		}
	}
	inserted, err := insertInbox(ctx, tx, chunk, ev)
	if err != nil {
		return false, "写入失败"
	}
	if inserted {
		return true, ""
	}
	stored, ok, err = loadInbox(ctx, tx, chunk.DeviceUID, ev.ID)
	if err != nil || !ok {
		return false, "写入失败"
	}
	return finishExisting(ctx, tx, chunk, ev, stored, owner)
}

func finishExisting(ctx context.Context, tx pgx.Tx, chunk domain.Chunk, ev domain.AcceptedEvent, stored domain.StoredInbox, owner string) (bool, string) {
	replay, reason := domain.CompareInbox(stored, ev, chunk.OrgID, chunk.UserID)
	if !replay {
		return false, reason
	}
	kept := domain.AcceptedEvent{ID: ev.ID, Kind: stored.Kind, Payload: stored.Payload, SchemaVersion: stored.SchemaVersion}
	rows, err := domain.BillableInputs(chunk.DeviceUID, kept)
	if err != nil {
		return false, "写入失败"
	}
	if len(rows) == 0 {
		return true, ""
	}
	if reason := recordUsage(ctx, tx, chunk, rows, owner); reason != "" {
		return false, reason
	}
	return true, ""
}

func loadInbox(ctx context.Context, tx pgx.Tx, device, id string) (domain.StoredInbox, bool, error) {
	var row domain.StoredInbox
	err := tx.QueryRow(ctx, `
		SELECT org_id, user_id, kind, payload_json, schema_version
		  FROM event_inbox_events
		 WHERE device_uid = $1 AND id = $2
		 LIMIT 1`, device, id).Scan(&row.OrgID, &row.UserID, &row.Kind, &row.Payload, &row.SchemaVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.StoredInbox{}, false, nil
	}
	if err != nil {
		return domain.StoredInbox{}, false, err
	}
	return row, true, nil
}

func insertInbox(ctx context.Context, tx pgx.Tx, chunk domain.Chunk, ev domain.AcceptedEvent) (bool, error) {
	var id string
	err := tx.QueryRow(ctx, `
		INSERT INTO event_inbox_events
		    (device_uid, id, org_id, user_id, kind, payload_json, client_created_at, schema_version, received_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())
		ON CONFLICT (device_uid, id) DO NOTHING
		RETURNING id`,
		chunk.DeviceUID, ev.ID, chunk.OrgID, chunk.UserID, ev.Kind, ev.Payload, ev.ClientCreatedAt, ev.SchemaVersion).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func recordUsage(ctx context.Context, tx pgx.Tx, chunk domain.Chunk, rows []domain.Billable, owner string) string {
	if chunk.OrgID > 0 {
		var id int64
		err := tx.QueryRow(ctx, `SELECT id FROM organizations WHERE id = $1 FOR UPDATE`, chunk.OrgID).Scan(&id)
		if err != nil {
			return "写入失败"
		}
	}
	missing := make([]domain.Billable, 0, len(rows))
	for _, row := range rows {
		var n int
		err := tx.QueryRow(ctx, `
			SELECT count(*) FROM billable_usage_events
			 WHERE org_id = $1 AND user_id = $2 AND event_id = $3 AND metric = $4`,
			chunk.OrgID, chunk.UserID, row.EventID, row.Metric).Scan(&n)
		if err != nil {
			return "写入失败"
		}
		if n == 0 {
			missing = append(missing, row)
		}
	}
	if len(missing) > 0 {
		if reason := quota(ctx, tx, chunk, missing); reason != "" {
			return reason
		}
	}
	nowMS := chunk.Now.UnixMilli()
	if chunk.Now.IsZero() {
		nowMS = time.Now().UnixMilli()
	}
	type roll struct {
		period, metric, unit, verification string
		total                              int64
	}
	var rolls []roll
	for _, row := range rows {
		var metric string
		err := tx.QueryRow(ctx, `
			INSERT INTO billable_usage_events
			    (org_id, user_id, owner_uuid, event_id, metric, unit, quantity, source,
			     verification, provider, model, resource_id, billing_period, details,
			     occurred_at_ms, created_at_ms)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)
			ON CONFLICT (org_id, user_id, event_id, metric) DO NOTHING
			RETURNING metric`,
			chunk.OrgID, chunk.UserID, owner, row.EventID, row.Metric, row.Unit, row.Quantity, row.Source,
			row.Verification, row.Provider, row.Model, row.ResourceID, row.Period, row.Details,
			row.OccurredAtMs, nowMS).Scan(&metric)
		if errors.Is(err, pgx.ErrNoRows) {
			if !usageMatches(ctx, tx, chunk, row) {
				return "写入失败"
			}
			continue
		}
		if err != nil {
			return "写入失败"
		}
		rolls = append(rolls, roll{row.Period, row.Metric, row.Unit, row.Verification, row.Quantity})
	}
	sort.Slice(rolls, func(i, j int) bool {
		if rolls[i].period != rolls[j].period {
			return rolls[i].period < rolls[j].period
		}
		if rolls[i].metric != rolls[j].metric {
			return rolls[i].metric < rolls[j].metric
		}
		if rolls[i].unit != rolls[j].unit {
			return rolls[i].unit < rolls[j].unit
		}
		return rolls[i].verification < rolls[j].verification
	})
	for _, row := range rolls {
		_, err := tx.Exec(ctx, `
			INSERT INTO billable_usage_rollups
			    (org_id, user_id, billing_period, metric, unit, verification, total, updated_at_ms)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			ON CONFLICT (org_id, user_id, billing_period, metric, unit, verification)
			DO UPDATE SET total = billable_usage_rollups.total + EXCLUDED.total,
			              updated_at_ms = EXCLUDED.updated_at_ms`,
			chunk.OrgID, chunk.UserID, row.period, row.metric, row.unit, row.verification, row.total, nowMS)
		if err != nil {
			return "写入失败"
		}
	}
	return ""
}

func quota(ctx context.Context, tx pgx.Tx, chunk domain.Chunk, missing []domain.Billable) string {
	var delta int64
	period := missing[0].Period
	minMS := missing[0].OccurredAtMs
	for _, row := range missing {
		if row.OccurredAtMs < minMS {
			minMS = row.OccurredAtMs
			period = row.Period
		}
		if row.Metric == "traffic.user_to_s3_bytes" {
			delta += row.Quantity
		}
	}
	if delta <= 0 {
		return ""
	}
	var used int64
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(total), 0)
		  FROM billable_usage_rollups
		 WHERE org_id = $1 AND billing_period = $2 AND metric = 'traffic.user_to_s3_bytes'`,
		chunk.OrgID, period).Scan(&used)
	if err != nil {
		return "写入失败"
	}
	if used > chunk.S3Limit || chunk.S3Limit-used < delta {
		return domain.QuotaMessage(used, chunk.S3Limit)
	}
	return ""
}

func usageMatches(ctx context.Context, tx pgx.Tx, chunk domain.Chunk, row domain.Billable) bool {
	var qty int64
	var unit, source, verification, provider, model, resource, period string
	var occurred int64
	var details []byte
	err := tx.QueryRow(ctx, `
		SELECT quantity, unit, source, verification, provider, model, resource_id,
		       billing_period, occurred_at_ms, details
		  FROM billable_usage_events
		 WHERE org_id = $1 AND user_id = $2 AND event_id = $3 AND metric = $4`,
		chunk.OrgID, chunk.UserID, row.EventID, row.Metric).Scan(
		&qty, &unit, &source, &verification, &provider, &model, &resource, &period, &occurred, &details)
	if err != nil {
		return false
	}
	return qty == row.Quantity && unit == row.Unit && source == row.Source && verification == row.Verification &&
		provider == row.Provider && model == row.Model && resource == row.ResourceID && period == row.Period &&
		occurred == row.OccurredAtMs && jsonEqual(details, row.Details)
}

func jsonEqual(stored []byte, want string) bool {
	var left, right any
	if json.Unmarshal(stored, &left) != nil || json.Unmarshal([]byte(want), &right) != nil {
		return false
	}
	lb, e1 := json.Marshal(left)
	rb, e2 := json.Marshal(right)
	return e1 == nil && e2 == nil && string(lb) == string(rb)
}

func auditMessage(accepted, rejected int) (string, error) {
	raw, err := json.Marshal(struct {
		Accepted int `json:"accepted"`
		Rejected int `json:"rejected"`
	}{accepted, rejected})
	return string(raw), err
}

func mapDB(err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "55P03":
			return &domain.Fail{Status: 503, Code: "INTERNAL", Message: "资源正在更新，请稍后重试", RetryAfter: "1"}
		case "P0M01":
			return &domain.Fail{Status: 409, Code: "INTERNAL", Message: "媒体对象已进入回收，请重新上传"}
		}
	}
	return domain.Unavailable()
}
