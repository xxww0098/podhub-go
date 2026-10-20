package readhttp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

// defaultLeaseSecs is DEFAULT_LEASE_SECS. Claim and heartbeat splice it in
// as interval '30 seconds'.
const defaultLeaseSecs int64 = 30

const jobReturning = `id::text, kind, aggregate_type, aggregate_id::text, input_revision,
	state, attempt, last_error_code, idempotency_key, payload, updated_at, lease_owner, lease_epoch`

func (h Host) claimJob(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	if h.Pool == nil {
		writeErr(w, http.StatusInternalServerError, "服务暂不可用", "internal")
		return
	}
	if err := h.reapPermits(r); err != nil {
		writeDB(w, err)
		return
	}
	id := chi.URLParam(r, "id")
	tx, err := tenant.BeginApp(r.Context(), h.Pool.Begin, p.OrgID)
	if err != nil {
		writeDB(w, err)
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	leased, quota, err := runClaimJob(r, tx, p.OrgID, id, true)
	if err != nil {
		writeDB(w, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeDB(w, err)
		return
	}
	if quota {
		w.Header().Set("Retry-After", "5")
		writeErr(w, http.StatusTooManyRequests, "当前用户的执行配额已用尽，请等待现有任务完成或停止后重试", "internal")
		return
	}
	writeClaim(w, leased)
}

// runClaimJob claims one browser job. headsFirst locks account_queue_head
// before the quota advisory locks, the same order as kernel Claim.
// media.render and media.upload return before either lock. Tests pass
// headsFirst false to replay the previous order.
func runClaimJob(r *http.Request, tx pgx.Tx, org int64, id string, headsFirst bool) (*browserClaim, bool, error) {
	var kind, aggregate, lane string
	var user *int64
	err := tx.QueryRow(r.Context(), `
		SELECT kind, submitter_user_id, aggregate_id::text, lane
		FROM jobs WHERE org_id = $1 AND id = $2::uuid
		  AND aggregate_type = 'listing_row'`, org, id).Scan(&kind, &user, &aggregate, &lane)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (kind == "media.render" || kind == "media.upload")) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if headsFirst && kind == "ai.recognize" {
		if err := lockAccountQueueHead(r.Context(), tx, userID(user), lane); err != nil {
			return nil, false, err
		}
	}
	class := browserPermitClass(kind)
	if err := lockExecutionQuota(r, tx, class, userID(user)); err != nil {
		return nil, false, err
	}
	var rowID string
	err = tx.QueryRow(r.Context(), `
		SELECT id::text FROM listing_rows WHERE org_id = $1 AND id = $2::uuid FOR UPDATE`,
		org, aggregate).Scan(&rowID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	leased, err := claimOne(r, tx, org, id, "")
	if err != nil {
		return nil, false, err
	}
	if leased == nil {
		return nil, false, nil
	}
	okGrant, err := grantJobPermit(r, tx, class, org, userID(user), id, leased.Lease.Epoch)
	if err != nil {
		return nil, false, err
	}
	if !okGrant {
		if err := rollbackClaim(r, tx, org, id, leased.Lease.Epoch); err != nil {
			return nil, false, err
		}
		return nil, true, nil
	}
	return leased, false, nil
}

func (h Host) claimWindow(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	raw, err := readBody(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	var fields map[string]json.RawMessage
	if err := decode(raw, &fields); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	for _, key := range []string{"jobIds", "kind", "limit"} {
		if _, ok := fields[key]; !ok {
			writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
			return
		}
	}
	var jobIDs []string
	var kind string
	var limit int64
	if err := json.Unmarshal(fields["jobIds"], &jobIDs); err != nil || json.Unmarshal(fields["kind"], &kind) != nil || json.Unmarshal(fields["limit"], &limit) != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 16 {
		limit = 16
	}
	if h.Pool == nil {
		writeErr(w, http.StatusInternalServerError, "服务暂不可用", "internal")
		return
	}
	if err := h.reapPermits(r); err != nil {
		writeDB(w, err)
		return
	}
	tx, err := tenant.BeginApp(r.Context(), h.Pool.Begin, p.OrgID)
	if err != nil {
		writeDB(w, err)
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	out, level, err := runClaimWindow(r, tx, p.OrgID, p.UserID, jobIDs, kind, limit, true)
	if err != nil {
		writeDB(w, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeDB(w, err)
		return
	}
	body := struct {
		Data       []browserClaim  `json:"data"`
		QueueLevel *queueLevelView `json:"queueLevel,omitempty"`
	}{Data: out, QueueLevel: level}
	if body.Data == nil {
		body.Data = []browserClaim{}
	}
	jsonwire.Write(w, http.StatusOK, body)
}

func (h Host) heartbeatJob(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	raw, err := readBody(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	var lease struct {
		Owner string `json:"owner"`
		Epoch int64  `json:"epoch"`
	}
	if err := decode(raw, &lease); err != nil || lease.Owner == "" {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	if h.Pool == nil {
		writeErr(w, http.StatusInternalServerError, "服务暂不可用", "internal")
		return
	}
	id := chi.URLParam(r, "id")
	var n int64
	err = h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE jobs SET lease_until = CASE WHEN state = 'running'
			        THEN clock_timestamp() + interval '30 seconds'
			        ELSE lease_until END,
			    updated_at = clock_timestamp()
			WHERE org_id = $1 AND id = $2::uuid
			  AND executor = 'browser'
			  AND kind = 'ai.recognize'
			  AND lease_owner = $3 AND lease_epoch = $4
			  AND (
			    (state = 'running' AND lease_until > clock_timestamp())
			    OR state = 'uncertain'
			  )`, p.OrgID, id, lease.Owner, lease.Epoch)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
		return nil
	})
	if !h.writeTx(w, err) {
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data bool `json:"data"`
	}{Data: n == 1})
}

func (h Host) reapPermits(r *http.Request) error {
	var n int64
	return h.Pool.QueryRow(r.Context(), `SELECT public.reap_stale_execution_permits(64)`).Scan(&n)
}

func browserPermitClass(kind string) string {
	switch kind {
	case "ai.recognize":
		return "ai_ocr"
	case "media.upload":
		return "cloud_upload"
	default:
		return "all_execution"
	}
}

func userID(id *int64) int64 {
	if id == nil {
		return 0
	}
	return *id
}

type windowCand struct {
	id, row, lane string
	user          int64
}

// runClaimWindow claims a browser batch. headsFirst locks each candidate's
// account_queue_head, ordered by lane then user, before any eq-live / eq-user
// advisory lock. The jobs update trigger locks that same head row, so the
// quota-first order deadlocks kernel Claim on ai.recognize. media.render and
// media.upload never enter this loop. Tests pass headsFirst false to replay
// the previous order and compare which jobs were claimed.
func runClaimWindow(r *http.Request, tx pgx.Tx, org, principal int64, jobIDs []string, kind string, limit int64, headsFirst bool) ([]browserClaim, *queueLevelView, error) {
	out := []browserClaim{}
	media := kind == "media.render" || kind == "media.upload"
	if len(jobIDs) > 0 && !media {
		class := browserPermitClass(kind)
		rows, err := tx.Query(r.Context(), `
			SELECT id::text, submitter_user_id, aggregate_id::text, lane
			FROM jobs
			WHERE org_id = $1
			  AND id = ANY(string_to_array($2, ',')::uuid[])
			  AND aggregate_type = 'listing_row'
			  AND kind = $3
			  AND executor = 'browser'
			  AND cancel_requested_at IS NULL
			  AND state IN ('queued', 'retry_wait')
			  AND run_at <= clock_timestamp()
			  AND (attempt < max_attempts OR last_error_code = 'uncertain_closed')
			ORDER BY priority ASC, created_at ASC, id ASC
			LIMIT $4`, org, strings.Join(jobIDs, ","), kind, limit)
		if err != nil {
			return nil, nil, err
		}
		var cands []windowCand
		for rows.Next() {
			var item windowCand
			var user *int64
			if err := rows.Scan(&item.id, &user, &item.row, &item.lane); err != nil {
				rows.Close()
				return nil, nil, err
			}
			item.user = userID(user)
			cands = append(cands, item)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, nil, err
		}
		rows.Close()
		if headsFirst {
			if err := lockBrowserHeads(r.Context(), tx, cands); err != nil {
				return nil, nil, err
			}
		}
		lockedUsers := map[int64]bool{}
		for _, item := range cands {
			if int64(len(out)) >= limit {
				break
			}
			if _, seen := lockedUsers[item.user]; !seen {
				held, err := tryLockExecutionQuota(r, tx, class, item.user)
				if err != nil {
					return nil, nil, err
				}
				lockedUsers[item.user] = held
			}
			if !lockedUsers[item.user] {
				continue
			}
			var locked string
			err := tx.QueryRow(r.Context(), `
				SELECT id::text FROM listing_rows
				WHERE org_id = $1 AND id = $2::uuid
				FOR UPDATE SKIP LOCKED`, org, item.row).Scan(&locked)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return nil, nil, err
			}
			leased, err := claimOne(r, tx, org, item.id, kind)
			if err != nil {
				return nil, nil, err
			}
			if leased == nil {
				continue
			}
			granted, err := grantJobPermit(r, tx, class, org, item.user, item.id, leased.Lease.Epoch)
			if err != nil {
				return nil, nil, err
			}
			if !granted {
				if err := rollbackClaim(r, tx, org, item.id, leased.Lease.Epoch); err != nil {
					return nil, nil, err
				}
				continue
			}
			out = append(out, *leased)
		}
	}
	level, err := queueLevel(r, tx, principal, kind)
	if err != nil {
		return nil, nil, err
	}
	return out, level, nil
}

func lockBrowserHeads(ctx context.Context, tx pgx.Tx, cands []windowCand) error {
	type key struct {
		lane string
		user int64
	}
	seen := map[key]bool{}
	var keys []key
	for _, item := range cands {
		k := key{lane: item.lane, user: item.user}
		if seen[k] {
			continue
		}
		seen[k] = true
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].lane != keys[j].lane {
			return keys[i].lane < keys[j].lane
		}
		return keys[i].user < keys[j].user
	})
	for _, k := range keys {
		if err := lockAccountQueueHead(ctx, tx, k.user, k.lane); err != nil {
			return err
		}
	}
	return nil
}

// lockAccountQueueHead locks the existing head row and does not insert one.
// A missing row stays missing, so queueLevel is still omitted when the
// trigger never created a head. The row lock is the same exclusive lock the
// refresh trigger takes on UPDATE.
func lockAccountQueueHead(ctx context.Context, tx pgx.Tx, user int64, lane string) error {
	var id int64
	err := tx.QueryRow(ctx, `
		SELECT user_id FROM account_queue_head
		WHERE user_id = $1 AND lane = $2
		FOR UPDATE`, user, lane).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}

func lockExecutionQuota(r *http.Request, tx pgx.Tx, class string, user int64) error {
	if _, err := tx.Exec(r.Context(), `
		SELECT pg_advisory_xact_lock(hashtextextended('eq-live:' || q.class, 0))
		FROM execution_quota q
		WHERE q.class = ANY(string_to_array($1, ','))
		  AND q.user_id = 0
		  AND NOT (q.class = 'ai_ocr' AND q.hard_limit = 0)
		ORDER BY q.class`, class); err != nil {
		return err
	}
	if _, err := tx.Exec(r.Context(), `
		SELECT pg_advisory_xact_lock(hashtextextended('eq-user:' || x || ':' || $2, 0))
		FROM unnest(string_to_array($1, ',')) x ORDER BY x`, class, strconv.FormatInt(user, 10)); err != nil {
		return err
	}
	_, err := tx.Exec(r.Context(), `
		INSERT INTO execution_quota(class, user_id, hard_limit)
		SELECT x, $2, public.execution_quota_user_limit(x)
		FROM unnest(string_to_array($1, ',')) x
		ON CONFLICT DO NOTHING`, class, user)
	return err
}

func tryLockExecutionQuota(r *http.Request, tx pgx.Tx, class string, user int64) (bool, error) {
	var classOK bool
	err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(bool_and(pg_try_advisory_xact_lock(hashtextextended('eq-live:' || q.class, 0))), true)
		FROM execution_quota q
		WHERE q.class = ANY(string_to_array($1, ','))
		  AND q.user_id = 0
		  AND NOT (q.class = 'ai_ocr' AND q.hard_limit = 0)`, class).Scan(&classOK)
	if err != nil || !classOK {
		return false, err
	}
	var userOK bool
	err = tx.QueryRow(r.Context(), `
		SELECT COALESCE(bool_and(pg_try_advisory_xact_lock(hashtextextended('eq-user:' || x || ':' || $2, 0))), true)
		FROM unnest(string_to_array($1, ',')) x`, class, strconv.FormatInt(user, 10)).Scan(&userOK)
	if err != nil || !userOK {
		return false, err
	}
	_, err = tx.Exec(r.Context(), `
		INSERT INTO execution_quota(class, user_id, hard_limit)
		SELECT x, $2, public.execution_quota_user_limit(x)
		FROM unnest(string_to_array($1, ',')) x
		ON CONFLICT DO NOTHING`, class, user)
	return err == nil, err
}

func claimOne(r *http.Request, tx pgx.Tx, org int64, id, kind string) (*browserClaim, error) {
	sql := `
		UPDATE jobs SET state = 'running',
		    lease_owner = gen_random_uuid()::text, lease_epoch = lease_epoch + 1,
		    lease_until = clock_timestamp() + interval '30 seconds',
		    attempt = attempt + 1, updated_at = clock_timestamp()
		WHERE org_id = $1 AND id = $2::uuid
		  AND aggregate_type = 'listing_row'
		  AND executor = 'browser'
		  AND cancel_requested_at IS NULL
		  AND state IN ('queued', 'retry_wait') AND run_at <= clock_timestamp()
		  AND (attempt < max_attempts OR last_error_code = 'uncertain_closed')`
	args := []any{org, id}
	if kind == "" {
		sql += ` AND kind IN ('ai.recognize', 'media.render', 'media.upload')`
	} else {
		sql += ` AND kind = $3`
		args = append(args, kind)
	}
	sql += ` RETURNING ` + jobReturning
	row := tx.QueryRow(r.Context(), sql, args...)
	item, err := scanLease(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func grantJobPermit(r *http.Request, tx pgx.Tx, class string, org, user int64, id string, epoch int64) (bool, error) {
	var ok bool
	err := tx.QueryRow(r.Context(), `
		SELECT public.try_grant_execution_permit(
			ARRAY[$1]::text[], $2, $3, 'job', $4, $5,
			clock_timestamp() + interval '30 seconds')`,
		class, org, user, id, epoch).Scan(&ok)
	return ok, err
}

func rollbackClaim(r *http.Request, tx pgx.Tx, org int64, id string, epoch int64) error {
	_, err := tx.Exec(r.Context(), `
		UPDATE jobs
		SET state = CASE
		        WHEN lease_until < clock_timestamp() THEN 'retry_wait'
		        ELSE 'queued'
		    END,
		    lease_owner = NULL,
		    lease_until = NULL,
		    lease_epoch = GREATEST(lease_epoch - 1, 0),
		    attempt = GREATEST(attempt - 1, 0),
		    updated_at = clock_timestamp()
		WHERE org_id = $1 AND id = $2::uuid AND lease_epoch = $3`, org, id, epoch)
	return err
}

type leaseView struct {
	Owner string `json:"owner"`
	Epoch int64  `json:"epoch"`
}

type browserClaim struct {
	Job          runView   `json:"job"`
	Lease        leaseView `json:"lease"`
	LeaseSeconds int64     `json:"leaseSeconds"`
}

type queueLevelView struct {
	Lane            string `json:"lane"`
	QueuedCost      int64  `json:"queuedCost"`
	QueuedCostLimit int64  `json:"queuedCostLimit"`
	RunningCost     int64  `json:"runningCost"`
}

func scanLease(row pgx.Row) (browserClaim, error) {
	var (
		item    browserClaim
		updated time.Time
		payload []byte
		last    *string
		owner   *string
		epoch   int64
		attempt int32
	)
	err := row.Scan(
		&item.Job.ID, &item.Job.Kind, &item.Job.AggregateType, &item.Job.AggregateID, &item.Job.InputRevision,
		&item.Job.State, &attempt, &last, &item.Job.IdempotencyKey, &payload, &updated, &owner, &epoch,
	)
	if err != nil {
		return browserClaim{}, err
	}
	item.Job.Attempt = attempt
	item.Job.LastErrorCode = last
	item.Job.Payload = payload
	if len(item.Job.Payload) == 0 {
		item.Job.Payload = []byte(`{}`)
	}
	item.Job.UpdatedAtMs = updated.UnixMilli()
	if owner != nil {
		item.Lease.Owner = *owner
	}
	item.Lease.Epoch = epoch
	item.LeaseSeconds = defaultLeaseSecs
	return item, nil
}

func queueLevel(r *http.Request, tx pgx.Tx, user int64, lane string) (*queueLevelView, error) {
	var queued, running int64
	err := tx.QueryRow(r.Context(), `
		SELECT queued_cost, running_cost FROM account_queue_head
		WHERE user_id = $1 AND lane = $2`, user, lane).Scan(&queued, &running)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &queueLevelView{Lane: lane, QueuedCost: queued, QueuedCostLimit: 256, RunningCost: running}, nil
}

func writeClaim(w http.ResponseWriter, data *browserClaim) {
	jsonwire.Write(w, http.StatusOK, struct {
		Data *browserClaim `json:"data"`
	}{Data: data})
}
