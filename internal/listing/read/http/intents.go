package readhttp

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/listing/read/domain"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

type halt struct {
	status int
	msg    string
	code   string
}

func (h halt) Error() string { return h.msg }

func (h Host) writeTx(w http.ResponseWriter, err error) bool {
	if err == nil {
		return true
	}
	var stop halt
	if errors.As(err, &stop) {
		writeErr(w, stop.status, stop.msg, stop.code)
		return false
	}
	status, message, code := dbStatus(err)
	if status == http.StatusServiceUnavailable {
		w.Header().Set("Retry-After", "1")
	}
	writeErr(w, status, message, code)
	return false
}

func (h Host) submit(w http.ResponseWriter, r *http.Request) (access.Principal, bool) {
	p, ok := h.account(w, r)
	if !ok {
		return access.Principal{}, false
	}
	if status, message, allowed := access.ListingSubmit(p); !allowed {
		writeErr(w, status, message, "forbidden")
		return access.Principal{}, false
	}
	return p, true
}

const intentCols = `id::text, store_id::text, listing_row_id::text, row_revision, client_operation_id, state,
external_task_id, last_error_code, reconciliation_outcome, submission_receipt, submission_issues,
cancel_requested_at, updated_at, created_at`

type loadedIntent struct {
	src     domain.IntentSource
	created time.Time
}

type scanner interface {
	Scan(dest ...any) error
}

func scanIntent(row scanner) (loadedIntent, error) {
	var item loadedIntent
	var cancel *time.Time
	err := row.Scan(
		&item.src.ID, &item.src.StoreID, &item.src.ListingRowID, &item.src.RowRevision, &item.src.ClientOperationID,
		&item.src.State, &item.src.ExternalTaskID, &item.src.LastErrorCode, &item.src.ReconciliationOutcome,
		&item.src.SubmissionReceipt, &item.src.SubmissionIssues, &cancel, &item.src.UpdatedAt, &item.created,
	)
	item.src.CancelRequestedAt = cancel
	return item, err
}

func (h Host) intents(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	filter, msg, valid := domain.ParseIntentQuery(r.URL.Query())
	if !valid {
		writeErr(w, http.StatusBadRequest, msg, "validation")
		return
	}
	var page []domain.IntentView
	var next *string
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		seat, found, err := loadSeat(r.Context(), tx, p.OrgID, p.UserID)
		if err != nil {
			return err
		}
		if !found {
			return halt{http.StatusForbidden, "工作空间成员当前不可用", "forbidden"}
		}
		if filter.ExactStore {
			access, err := storeAccess(r.Context(), tx, p.OrgID, p.UserID, filter.StoreID)
			if err != nil {
				return err
			}
			if access == storeMember {
				return halt{http.StatusForbidden, "工作空间成员当前不可用", "forbidden"}
			}
			if access != storeOK {
				return halt{http.StatusNotFound, "Store 不存在", "not_found"}
			}
		}
		rows, err := queryIntents(r.Context(), tx, p.OrgID, seat, filter)
		if err != nil {
			return err
		}
		if int64(len(rows)) > filter.Limit {
			last := rows[filter.Limit-1]
			at := last.src.UpdatedAt
			if filter.StableOrder {
				at = last.created
			}
			cursor := domain.FormatCursor(domain.CursorMicros(at), last.src.ID)
			next = &cursor
			rows = rows[:filter.Limit]
		}
		if err := attachFacts(r.Context(), tx, p.OrgID, rows); err != nil {
			return err
		}
		page = make([]domain.IntentView, len(rows))
		for i, row := range rows {
			page[i] = domain.ProjectIntent(row.src)
		}
		return nil
	})
	if !h.writeTx(w, err) {
		return
	}
	if page == nil {
		page = []domain.IntentView{}
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data struct {
			Items      []domain.IntentView `json:"items"`
			NextCursor *string             `json:"next_cursor,omitempty"`
		} `json:"data"`
	}{Data: struct {
		Items      []domain.IntentView `json:"items"`
		NextCursor *string             `json:"next_cursor,omitempty"`
	}{Items: page, NextCursor: next}})
}

func (h Host) getIntent(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		writeErr(w, http.StatusNotFound, "提交意图不存在", "not_found")
		return
	}
	var view domain.IntentView
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		item, err := oneIntent(r.Context(), tx, p.OrgID, p.UserID, id)
		if err != nil {
			return err
		}
		rows := []loadedIntent{item}
		if err := attachFacts(r.Context(), tx, p.OrgID, rows); err != nil {
			return err
		}
		view = domain.ProjectIntent(rows[0].src)
		return nil
	})
	if !h.writeTx(w, err) {
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data domain.IntentView `json:"data"`
	}{Data: view})
}

func (h Host) cancelIntent(w http.ResponseWriter, r *http.Request) {
	p, ok := h.submit(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		writeErr(w, http.StatusNotFound, "提交意图不存在", "not_found")
		return
	}
	var view domain.IntentView
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		before, err := oneIntent(r.Context(), tx, p.OrgID, p.UserID, id)
		if err != nil {
			return err
		}
		if err := lockLiveOrg(r.Context(), tx, p.OrgID, "提交意图不存在"); err != nil {
			return err
		}
		row := tx.QueryRow(r.Context(), `
			UPDATE submission_intents
			SET cancel_requested_at = COALESCE(cancel_requested_at, clock_timestamp()),
			    state = CASE WHEN state = 'queued' AND external_task_id IS NULL THEN 'cancelled' ELSE state END,
			    updated_at = clock_timestamp()
			WHERE org_id = $1 AND id = $2::uuid
			RETURNING `+intentCols, p.OrgID, id)
		item, err := scanIntent(row)
		if errors.Is(err, pgx.ErrNoRows) {
			return halt{http.StatusNotFound, "提交意图不存在", "not_found"}
		}
		if err != nil {
			return err
		}
		if domain.CancelMovesToCancelled(before.src.State, before.src.ExternalTaskID) {
			if _, err := tx.Exec(r.Context(), `
				UPDATE listing_rows
				SET submission_state = 'cancelled', updated_at = clock_timestamp()
				WHERE org_id = $1 AND id = $2::uuid AND revision = $3 AND submission_state = 'queued'`,
				p.OrgID, before.src.ListingRowID, before.src.RowRevision); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE jobs
			SET cancel_requested_at = COALESCE(cancel_requested_at, clock_timestamp()),
			    updated_at = clock_timestamp()
			WHERE org_id = $1 AND aggregate_type = 'submission_intent' AND aggregate_id = $2::uuid
			  AND state IN ('queued', 'retry_wait', 'running')`, p.OrgID, id); err != nil {
			return err
		}
		view = domain.ProjectIntent(item.src)
		return nil
	})
	if !h.writeTx(w, err) {
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data domain.IntentView `json:"data"`
	}{Data: view})
}

func (h Host) probeIntent(w http.ResponseWriter, r *http.Request) {
	p, ok := h.submit(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		writeErr(w, http.StatusNotFound, "提交意图不存在", "not_found")
		return
	}
	var state, last, offer, storeID string
	var claim *time.Time
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT state, COALESCE(last_error_code, ''), COALESCE(offer_id, ''), reconcile_claim_until, store_id::text
			FROM submission_intents WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, id).
			Scan(&state, &last, &offer, &claim, &storeID)
		if errors.Is(err, pgx.ErrNoRows) {
			return halt{http.StatusNotFound, "提交意图不存在", "not_found"}
		}
		if err != nil {
			return err
		}
		return requireIntentStore(r.Context(), tx, p.OrgID, p.UserID, storeID)
	})
	if !h.writeTx(w, err) {
		return
	}
	if msg, conflict := domain.ProbeRefusal(state, last, offer, claim, h.Now()); conflict {
		writeErr(w, http.StatusConflict, msg, "conflict")
		return
	}
	h.runProbe(w, r, p.OrgID, p.UserID, id, offer, storeID)
}

func (h Host) recoverIntent(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.submit(w, r); !ok {
		return
	}
	writeErr(w, http.StatusGone, "未取得响应的发送不会重放，请在 Ozon 查看原请求", "gone")
}

func (h Host) releaseUnknown(w http.ResponseWriter, r *http.Request) {
	p, ok := h.submit(w, r)
	if !ok {
		return
	}
	body, err := readBody(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	var req struct {
		IntentIDs []string `json:"intentIds"`
	}
	if err := decode(body, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	ids, msg, valid := domain.ParseReleaseIDs(req.IntentIDs)
	if !valid {
		writeErr(w, http.StatusBadRequest, msg, "validation")
		return
	}
	var released []string
	var views []domain.IntentView
	err = h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT id::text, store_id::text FROM submission_intents
			WHERE org_id = $1 AND id = ANY($2::uuid[])`, p.OrgID, ids)
		if err != nil {
			return err
		}
		loaded := []string{}
		stores := []string{}
		seenStore := map[string]struct{}{}
		for rows.Next() {
			var id, store string
			if err := rows.Scan(&id, &store); err != nil {
				rows.Close()
				return err
			}
			loaded = append(loaded, id)
			if _, ok := seenStore[store]; !ok {
				seenStore[store] = struct{}{}
				stores = append(stores, store)
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if len(loaded) == 0 || len(stores) == 0 {
			released = []string{}
			views = []domain.IntentView{}
			return nil
		}
		if err := lockLiveOrg(r.Context(), tx, p.OrgID, "Store 不存在"); err != nil {
			return err
		}
		for _, store := range stores {
			access, err := storeAccess(r.Context(), tx, p.OrgID, p.UserID, store)
			if err != nil {
				return err
			}
			if access == storeMember {
				return halt{http.StatusForbidden, "工作空间成员当前不可用", "forbidden"}
			}
			if access != storeOK {
				return halt{http.StatusNotFound, "Store 不存在", "not_found"}
			}
		}
		rel, err := tx.Query(r.Context(), `
			UPDATE submission_intents i
			SET state = 'superseded',
			    reconciliation_outcome = COALESCE(i.reconciliation_outcome, '{}'::jsonb)
			        || jsonb_build_object('released', jsonb_build_object(
			            'byUserId', $3::bigint,
			            'atMs', (extract(epoch from clock_timestamp()) * 1000)::bigint)),
			    submission_issues = (SELECT COALESCE(jsonb_agg(
			        CASE WHEN issue->>'resolvedAtMs' IS NULL
			             THEN jsonb_set(issue, '{resolvedAtMs}',
			                  to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint))
			             ELSE issue END ORDER BY ord), '[]'::jsonb)
			        FROM jsonb_array_elements(i.submission_issues) WITH ORDINALITY e(issue, ord)),
			    reconcile_after = NULL,
			    updated_at = clock_timestamp()
			WHERE i.org_id = $1
			  AND i.id = ANY($2::uuid[])
			  AND i.store_id = ANY($4::uuid[])
			  AND i.state = 'unknown'
			  AND (i.reconcile_claim_until IS NULL OR i.reconcile_claim_until <= clock_timestamp())
			  AND NOT EXISTS (
			    SELECT 1 FROM jobs j
			     WHERE j.org_id = i.org_id
			       AND j.kind = 'listing.submit.batch'
			       AND j.state IN ('queued', 'running', 'retry_wait', 'uncertain')
			       AND j.payload->'intents' @> jsonb_build_array(jsonb_build_object('intentId', i.id::text))
			  )
			RETURNING i.id::text`, p.OrgID, loaded, p.UserID, stores)
		if err != nil {
			return err
		}
		released = []string{}
		for rel.Next() {
			var id string
			if err := rel.Scan(&id); err != nil {
				rel.Close()
				return err
			}
			released = append(released, id)
		}
		err = rel.Err()
		rel.Close()
		if err != nil {
			return err
		}
		if len(released) > 0 {
			if _, err := tx.Exec(r.Context(), `
				UPDATE listing_rows r
				SET submission_state = 'none', updated_at = clock_timestamp()
				FROM submission_intents i
				WHERE i.org_id = r.org_id AND i.listing_row_id = r.id AND i.row_revision = r.revision
				  AND i.org_id = $1 AND i.id = ANY($2::uuid[])`, p.OrgID, released); err != nil {
				return err
			}
		}
		again, err := tx.Query(r.Context(), `SELECT `+intentCols+` FROM submission_intents WHERE org_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`, p.OrgID, loaded)
		if err != nil {
			return err
		}
		defer again.Close()
		views = []domain.IntentView{}
		for again.Next() {
			item, err := scanIntent(again)
			if err != nil {
				return err
			}
			views = append(views, domain.ProjectIntent(item.src))
		}
		return again.Err()
	})
	if !h.writeTx(w, err) {
		return
	}
	if released == nil {
		released = []string{}
	}
	if views == nil {
		views = []domain.IntentView{}
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data struct {
			ReleasedIntentIDs []string            `json:"released_intent_ids"`
			Intents           []domain.IntentView `json:"intents"`
		} `json:"data"`
	}{Data: struct {
		ReleasedIntentIDs []string            `json:"released_intent_ids"`
		Intents           []domain.IntentView `json:"intents"`
	}{ReleasedIntentIDs: released, Intents: views}})
}

type membership struct {
	id        int64
	manageAll bool
}

func loadSeat(ctx context.Context, tx pgx.Tx, orgID, userID int64) (membership, bool, error) {
	var seat membership
	var role string
	err := tx.QueryRow(ctx, `
		SELECT id, role FROM organization_members
		WHERE org_id = $1 AND user_id = $2 AND status = 'active' AND NOT manual_disabled AND NOT quota_suspended`,
		orgID, userID).Scan(&seat.id, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return membership{}, false, nil
	}
	if err != nil {
		return membership{}, false, err
	}
	seat.manageAll = access.CanManage(role)
	return seat, true, nil
}

type storeKind int

const (
	storeOK storeKind = iota
	storeMissing
	storeMember
)

func storeAccess(ctx context.Context, tx pgx.Tx, orgID, userID int64, storeID string) (storeKind, error) {
	var assignee *int64
	var membershipID *int64
	var role *string
	err := tx.QueryRow(ctx, `
		SELECT s.assignee_membership_id, m.id, m.role
		FROM organization_stores s
		LEFT JOIN organization_members m
		  ON m.org_id = s.org_id AND m.user_id = $3 AND m.status = 'active' AND NOT m.manual_disabled AND NOT m.quota_suspended
		WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.deleted_at_ms IS NULL
		LIMIT 1`, orgID, storeID, userID).Scan(&assignee, &membershipID, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return storeMissing, nil
	}
	if err != nil {
		return 0, err
	}
	if membershipID == nil || role == nil || strings.TrimSpace(*role) == "" {
		return storeMember, nil
	}
	if !access.StoreVisible(*role, assignee, *membershipID) {
		return storeMissing, nil
	}
	return storeOK, nil
}

func requireIntentStore(ctx context.Context, tx pgx.Tx, orgID, userID int64, storeID string) error {
	access, err := storeAccess(ctx, tx, orgID, userID, storeID)
	if err != nil {
		return err
	}
	if access == storeMember {
		return halt{http.StatusForbidden, "工作空间成员当前不可用", "forbidden"}
	}
	if access != storeOK {
		return halt{http.StatusNotFound, "提交意图不存在", "not_found"}
	}
	return nil
}

func oneIntent(ctx context.Context, tx pgx.Tx, orgID, userID int64, id string) (loadedIntent, error) {
	item, err := scanIntent(tx.QueryRow(ctx, `SELECT `+intentCols+` FROM submission_intents WHERE org_id = $1 AND id = $2::uuid`, orgID, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return loadedIntent{}, halt{http.StatusNotFound, "提交意图不存在", "not_found"}
	}
	if err != nil {
		return loadedIntent{}, err
	}
	if err := requireIntentStore(ctx, tx, orgID, userID, item.src.StoreID); err != nil {
		return loadedIntent{}, err
	}
	return item, nil
}

func lockLiveOrg(ctx context.Context, tx pgx.Tx, orgID int64, missing string) error {
	var dissolved bool
	err := tx.QueryRow(ctx, `
		SELECT dissolved_at IS NOT NULL FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, orgID).Scan(&dissolved)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && dissolved) {
		return halt{http.StatusNotFound, missing, "not_found"}
	}
	return err
}

func queryIntents(ctx context.Context, tx pgx.Tx, orgID int64, seat membership, f domain.IntentFilter) ([]loadedIntent, error) {
	args := []any{orgID, seat.manageAll, seat.id}
	var where strings.Builder
	where.WriteString(`org_id = $1 AND store_id IN (
		SELECT s.uuid FROM organization_stores s
		WHERE s.org_id = $1 AND s.deleted_at_ms IS NULL
		  AND ($2::boolean OR s.assignee_membership_id = $3))`)
	add := func(clause string, value any) {
		args = append(args, value)
		where.WriteString(clause)
		where.WriteString(placeholder(len(args)))
	}
	if f.RowID != "" {
		add(` AND listing_row_id = `, f.RowID)
		where.WriteString(`::uuid`)
	}
	if f.RowIDs != nil {
		if len(f.RowIDs) == 0 {
			where.WriteString(` AND false`)
		} else {
			add(` AND listing_row_id = ANY(`, f.RowIDs)
			where.WriteString(`::uuid[])`)
		}
	}
	if f.IntentIDs != nil {
		if len(f.IntentIDs) == 0 {
			where.WriteString(` AND false`)
		} else {
			add(` AND id = ANY(`, f.IntentIDs)
			where.WriteString(`::uuid[])`)
		}
	}
	if f.ExactStore {
		add(` AND store_id = `, f.StoreID)
		where.WriteString(`::uuid`)
	}
	if f.CardID != "" {
		add(` AND card_id = `, f.CardID)
		where.WriteString(`::uuid`)
	}
	orderCol := domain.SortTimeColumn(f.StableOrder)
	var sql string
	if f.LatestPerRow {
		sql = `WITH selected AS (
			SELECT DISTINCT ON (listing_row_id) * FROM submission_intents
			WHERE ` + where.String() + `
			ORDER BY listing_row_id, row_revision DESC, created_at DESC, id DESC)
			SELECT ` + intentCols + ` FROM selected`
		if f.CursorID != "" {
			args = append(args, f.CursorMicros, f.CursorID)
			micros := placeholder(len(args) - 1)
			id := placeholder(len(args))
			sql += ` WHERE (` + orderCol + `, id) < ((TIMESTAMPTZ 'epoch' + (` + micros + `::bigint || ' microseconds')::interval), ` + id + `::uuid)`
		}
	} else {
		sql = `SELECT ` + intentCols + ` FROM submission_intents WHERE ` + where.String()
		if f.CursorID != "" {
			args = append(args, f.CursorMicros, f.CursorID)
			micros := placeholder(len(args) - 1)
			id := placeholder(len(args))
			sql += ` AND (` + orderCol + `, id) < ((TIMESTAMPTZ 'epoch' + (` + micros + `::bigint || ' microseconds')::interval), ` + id + `::uuid)`
		}
	}
	args = append(args, f.Fetch)
	sql += ` ORDER BY ` + orderCol + ` DESC, id DESC LIMIT ` + placeholder(len(args))
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []loadedIntent
	for rows.Next() {
		item, err := scanIntent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func placeholder(n int) string {
	return "$" + itoa(n)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [4]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func attachFacts(ctx context.Context, tx pgx.Tx, orgID int64, rows []loadedIntent) error {
	if len(rows) == 0 {
		return nil
	}
	if len(rows) > 100 {
		return errors.New("release facts require at most 100 same-tenant Intents")
	}
	ids := make([]string, len(rows))
	stores := make([]string, len(rows))
	listings := make([]string, len(rows))
	revs := make([]int64, len(rows))
	ops := make([]string, len(rows))
	states := make([]string, len(rows))
	updated := make([]time.Time, len(rows))
	for i, row := range rows {
		ids[i] = row.src.ID
		stores[i] = row.src.StoreID
		listings[i] = row.src.ListingRowID
		revs[i] = row.src.RowRevision
		ops[i] = row.src.ClientOperationID
		states[i] = row.src.State
		updated[i] = row.src.UpdatedAt
	}
	found, err := tx.Query(ctx, `
		SELECT i.id::text,
		       COALESCE(i.reconcile_claim_until > clock_timestamp(), false),
		       EXISTS (
		           SELECT 1 FROM jobs j
		            WHERE j.org_id = i.org_id
		              AND j.kind = 'listing.submit.batch'
		              AND j.state IN ('queued', 'running', 'retry_wait', 'uncertain')
		              AND j.payload->'intents' @> jsonb_build_array(jsonb_build_object('intentId', i.id::text))
		       )
		  FROM submission_intents i
		  JOIN unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::bigint[], $6::text[], $7::text[], $8::timestamptz[])
		    AS snapshot(id, store_id, listing_row_id, row_revision, client_operation_id, state, updated_at)
		    ON i.id = snapshot.id AND i.store_id = snapshot.store_id
		   AND i.listing_row_id = snapshot.listing_row_id
		   AND i.row_revision = snapshot.row_revision
		   AND i.client_operation_id = snapshot.client_operation_id
		   AND i.state = snapshot.state AND i.updated_at = snapshot.updated_at
		 WHERE i.org_id = $1`, orgID, ids, stores, listings, revs, ops, states, updated)
	if err != nil {
		return err
	}
	defer found.Close()
	type fact struct{ live, job bool }
	facts := map[string]fact{}
	for found.Next() {
		var id string
		var item fact
		if err := found.Scan(&id, &item.live, &item.job); err != nil {
			return err
		}
		facts[id] = item
	}
	if err := found.Err(); err != nil {
		return err
	}
	for i := range rows {
		item, ok := facts[rows[i].src.ID]
		if !ok {
			continue
		}
		live, job := item.live, item.job
		rows[i].src.HasLiveReconcileClaim = &live
		rows[i].src.HasUnfinishedDispatch = &job
	}
	return nil
}
