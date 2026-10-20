package readhttp

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

type cardView struct {
	ID              string          `json:"id"`
	Title           string          `json:"title"`
	StoreID         *string         `json:"storeId,omitempty"`
	Revision        int64           `json:"revision"`
	Payload         json.RawMessage `json:"payload"`
	UpdatedAtMs     int64           `json:"updatedAtMs"`
	OcrPromptSha256 *string         `json:"ocrPromptSha256,omitempty"`
}

type cardRow struct {
	view         cardView
	supplier     bool
	payload      []byte
	cursorMicros int64
}

func scanCard(row pgx.Row) (cardRow, error) {
	var (
		id, title string
		store     *string
		revision  int64
		payload   []byte
		updated   time.Time
		supplier  *string
	)
	if err := row.Scan(&id, &title, &store, &revision, &payload, &updated, &supplier); err != nil {
		return cardRow{}, err
	}
	body, err := jsonwire.Canonical(payload)
	if err != nil {
		return cardRow{}, err
	}
	if store != nil && *store == "" {
		store = nil
	}
	bound := payloadHasSupplier(payload)
	return cardRow{
		view: cardView{
			ID: id, Title: title, StoreID: store, Revision: revision,
			Payload: body, UpdatedAtMs: updated.UnixMilli(),
		},
		supplier:     bound,
		payload:      payload,
		cursorMicros: updated.UnixMicro(),
	}, nil
}

const cardSelect = `id::text, title, store_id::text, revision, payload, updated_at, supplier_product_id`

func (h Host) listCards(w http.ResponseWriter, r *http.Request) {
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
	_, fetch := PageFetch(limit)
	micros, afterID := ParseCursor(q.Get("cursor"))
	store := q.Get("storeId")
	var rows []cardRow
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		// Placeholders are numbered only for arguments that appear. An unused
		// $2 makes Postgres reject the statement (42P18) before any row is read.
		sql := `SELECT ` + cardSelect + ` FROM listing_cards WHERE org_id = $1`
		args := []any{p.OrgID}
		if store != "" {
			args = append(args, store)
			sql += fmt.Sprintf(` AND store_id = $%d::uuid`, len(args))
		}
		if micros != 0 {
			args = append(args, micros, afterID)
			sql += fmt.Sprintf(` AND (updated_at, id) < ((TIMESTAMPTZ 'epoch' + ($%d::bigint || ' microseconds')::interval), $%d::uuid)`, len(args)-1, len(args))
		}
		args = append(args, fetch)
		sql += fmt.Sprintf(` ORDER BY updated_at DESC, id DESC LIMIT $%d`, len(args))
		listed, err := tx.Query(r.Context(), sql, args...)
		if err != nil {
			return err
		}
		defer listed.Close()
		for listed.Next() {
			item, err := scanCard(listed)
			if err != nil {
				return err
			}
			rows = append(rows, item)
		}
		return listed.Err()
	})
	if err != nil {
		status, message, code := dbStatus(err)
		writeErr(w, status, message, code)
		return
	}
	var next *string
	if int64(len(rows)) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		cursor := FormatCursor(last.cursorMicros, last.view.ID)
		next = &cursor
	}
	items := make([]cardView, 0, len(rows))
	for _, item := range rows {
		items = append(items, item.view)
	}
	jsonwire.Write(w, http.StatusOK, cardPage{Data: cardPageData{Items: items, NextCursor: next}})
}

type cardPageData struct {
	Items      []cardView `json:"items"`
	NextCursor *string    `json:"nextCursor,omitempty"`
}

type cardPage struct {
	Data cardPageData `json:"data"`
}

func (h Host) getCard(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "cardId 无效", "validation")
		return
	}
	item, err := h.loadCard(r, p.OrgID, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "上架方案不存在", "not_found")
			return
		}
		status, message, code := dbStatus(err)
		writeErr(w, status, message, code)
		return
	}
	if sha := promptSHA(item.payload); sha != "" {
		item.view.OcrPromptSha256 = &sha
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data cardView `json:"data"`
	}{Data: item.view})
}

func (h Host) loadCard(r *http.Request, org int64, id string) (cardRow, error) {
	var item cardRow
	err := h.withOrg(r.Context(), org, func(tx pgx.Tx) error {
		row := tx.QueryRow(r.Context(), `SELECT `+cardSelect+` FROM listing_cards WHERE org_id = $1 AND id = $2::uuid`, org, id)
		var scanErr error
		item, scanErr = scanCard(row)
		return scanErr
	})
	return item, err
}
