package readhttp

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/listing/read/domain"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

func (h Host) deadLetters(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	limit, ok := ParseLimit(q.Get("limit"), q.Has("limit"))
	if !ok {
		writeErr(w, http.StatusBadRequest, "limit 无效", "validation")
		return
	}
	fetch := limit + 1
	micros, cursorID := ParseCursor(q.Get("cursor"))
	var items []deadLetterView
	var next *string
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		sql := `SELECT id::text, kind, aggregate_type, aggregate_id::text, state, attempt, max_attempts,
		               last_error_code, idempotency_key, executor, updated_at
		          FROM jobs
		         WHERE org_id = $1 AND state = 'failed' AND attempt >= max_attempts`
		args := []any{p.OrgID}
		if cursorID != "" {
			args = append(args, micros, cursorID)
			sql += ` AND (updated_at, id) < ((TIMESTAMPTZ 'epoch' + ($2::bigint || ' microseconds')::interval), $3::uuid)`
		}
		args = append(args, fetch)
		sql += ` ORDER BY updated_at DESC, id DESC LIMIT $` + itoa(len(args))
		rows, err := tx.Query(r.Context(), sql, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		var page []deadLetter
		for rows.Next() {
			var item deadLetter
			var executor string
			if err := rows.Scan(&item.id, &item.kind, &item.aggregateType, &item.aggregateID, &item.state,
				&item.attempt, &item.maxAttempts, &item.lastError, &item.idempotency, &executor, &item.updated); err != nil {
				return err
			}
			if executor != "" {
				item.executor = &executor
			}
			page = append(page, item)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if int64(len(page)) > limit {
			last := page[limit-1]
			cursor := FormatCursor(domain.CursorMicros(last.updated), last.id)
			next = &cursor
			page = page[:limit]
		}
		items = make([]deadLetterView, len(page))
		for i, item := range page {
			items[i] = item.view()
		}
		return nil
	})
	if !h.writeTx(w, err) {
		return
	}
	if items == nil {
		items = []deadLetterView{}
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data struct {
			Items      []deadLetterView `json:"items"`
			NextCursor *string          `json:"nextCursor,omitempty"`
		} `json:"data"`
	}{Data: struct {
		Items      []deadLetterView `json:"items"`
		NextCursor *string          `json:"nextCursor,omitempty"`
	}{Items: items, NextCursor: next}})
}

func (h Host) requeueDeadLetter(w http.ResponseWriter, r *http.Request) {
	p, ok := h.submit(w, r)
	if !ok {
		return
	}
	jobID, ok := CanonicalUUID(chi.URLParam(r, "job_id"))
	if !ok {
		writeErr(w, http.StatusBadRequest, "作业编号无效", "validation")
		return
	}
	var view runView
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		var item deadLetter
		var executor string
		err := tx.QueryRow(r.Context(), `
			SELECT id::text, kind, aggregate_type, aggregate_id::text, state, attempt, max_attempts,
			       last_error_code, idempotency_key, executor, updated_at
			  FROM jobs
			 WHERE org_id = $1 AND id = $2::uuid AND state = 'failed' AND attempt >= max_attempts
			 FOR UPDATE`, p.OrgID, jobID).Scan(
			&item.id, &item.kind, &item.aggregateType, &item.aggregateID, &item.state,
			&item.attempt, &item.maxAttempts, &item.lastError, &item.idempotency, &executor, &item.updated)
		if errors.Is(err, pgx.ErrNoRows) {
			return halt{http.StatusConflict, "只有耗尽重试次数的失败终态才是死信；该作业不在死信集合内", "conflict"}
		}
		if err != nil {
			return err
		}
		code, refused := domain.ReplayRefusal(item.kind, executor == "browser", deref(item.lastError), item.lastError != nil)
		if refused {
			return halt{http.StatusConflict, domain.RefusalSentence(code) + "（refusal: " + code + "）", "not_replayable"}
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE jobs
			   SET state = 'queued', attempt = 0, lease_owner = NULL, lease_until = NULL,
			       run_at = clock_timestamp(), updated_at = clock_timestamp()
			 WHERE org_id = $1 AND id = $2::uuid AND state = 'failed' AND attempt >= max_attempts`,
			p.OrgID, jobID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return halt{http.StatusConflict, "只有耗尽重试次数的失败终态才是死信；该作业不在死信集合内", "conflict"}
		}
		err = tx.QueryRow(r.Context(), `
			SELECT id::text, kind, aggregate_type, aggregate_id::text, input_revision, state, attempt,
			       last_error_code, idempotency_key, payload, updated_at
			  FROM jobs WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, jobID).Scan(
			&view.ID, &view.Kind, &view.AggregateType, &view.AggregateID, &view.InputRevision, &view.State,
			&view.Attempt, &view.LastErrorCode, &view.IdempotencyKey, &view.Payload, &view.updated)
		if errors.Is(err, pgx.ErrNoRows) {
			return halt{http.StatusConflict, "只有耗尽重试次数的失败终态才是死信；该作业不在死信集合内", "conflict"}
		}
		return err
	})
	if !h.writeTx(w, err) {
		return
	}
	view.UpdatedAtMs = view.updated.UnixMilli()
	jsonwire.Write(w, http.StatusOK, struct {
		Data runView `json:"data"`
	}{Data: view})
}

type deadLetter struct {
	id            string
	kind          string
	aggregateType string
	aggregateID   string
	state         string
	attempt       int32
	maxAttempts   int32
	lastError     *string
	idempotency   string
	executor      *string
	updated       time.Time
}

func (d deadLetter) view() deadLetterView {
	code, refused := domain.ReplayRefusal(d.kind, d.executor != nil && *d.executor == "browser", deref(d.lastError), d.lastError != nil)
	view := deadLetterView{
		ID: d.id, Kind: d.kind, AggregateType: d.aggregateType, AggregateID: d.aggregateID,
		State: d.state, Attempt: d.attempt, MaxAttempts: d.maxAttempts, LastErrorCode: d.lastError,
		IdempotencyKey: d.idempotency, Replayable: !refused, UpdatedAtMs: d.updated.UnixMilli(),
	}
	if d.executor != nil && *d.executor != "" {
		view.Executor = d.executor
	}
	if refused {
		view.ReplayRefusal = &code
	}
	return view
}

type deadLetterView struct {
	ID             string  `json:"id"`
	Kind           string  `json:"kind"`
	AggregateType  string  `json:"aggregateType"`
	AggregateID    string  `json:"aggregateId"`
	State          string  `json:"state"`
	Attempt        int32   `json:"attempt"`
	MaxAttempts    int32   `json:"maxAttempts"`
	LastErrorCode  *string `json:"lastErrorCode,omitempty"`
	IdempotencyKey string  `json:"idempotencyKey"`
	Executor       *string `json:"executor,omitempty"`
	Replayable     bool    `json:"replayable"`
	ReplayRefusal  *string `json:"replayRefusal,omitempty"`
	UpdatedAtMs    int64   `json:"updatedAtMs"`
}

type runView struct {
	ID             string          `json:"id"`
	Kind           string          `json:"kind"`
	AggregateType  string          `json:"aggregateType"`
	AggregateID    string          `json:"aggregateId"`
	InputRevision  int64           `json:"inputRevision"`
	State          string          `json:"state"`
	Attempt        int32           `json:"attempt"`
	LastErrorCode  *string         `json:"lastErrorCode,omitempty"`
	IdempotencyKey string          `json:"idempotencyKey"`
	Payload        json.RawMessage `json:"payload"`
	UpdatedAtMs    int64           `json:"updatedAtMs"`
	updated        time.Time
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
