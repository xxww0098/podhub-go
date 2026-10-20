package readhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

func (h Host) withSnapshot(ctx context.Context, tx pgx.Tx, item storedScan) (storedScan, error) {
	next, err := HydratePayload(item.row.Payload, func(revision string) (json.RawMessage, bool, error) {
		var snap []byte
		err := tx.QueryRow(ctx, `SELECT snapshot FROM listing_schema_revisions WHERE schema_revision = $1`, revision).Scan(&snap)
		if err != nil {
			if err == pgx.ErrNoRows {
				return nil, false, nil
			}
			return nil, false, err
		}
		return snap, true, nil
	})
	if err != nil {
		return item, err
	}
	item.row.Payload = next
	return item, nil
}

// hydrateRows loads every schema snapshot this page still needs in one
// statement, then hydrates in the scanned order. Rows that already carry
// schemaSnapshot are not part of the lookup. A missing revision still fails
// on the first such row, with the same sentence HydratePayload returns.
func (h Host) hydrateRows(ctx context.Context, tx pgx.Tx, scanned []storedScan) ([]storedScan, error) {
	revs := make([]string, 0)
	seen := map[string]struct{}{}
	for _, item := range scanned {
		rev, ok := SchemaRevisionToFetch(item.row.Payload)
		if !ok {
			continue
		}
		if _, dup := seen[rev]; dup {
			continue
		}
		seen[rev] = struct{}{}
		revs = append(revs, rev)
	}
	snaps := map[string]json.RawMessage{}
	if len(revs) > 0 {
		rows, err := tx.Query(ctx, `SELECT schema_revision, snapshot FROM listing_schema_revisions WHERE schema_revision = ANY($1::text[])`, revs)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var rev string
			var snap []byte
			if err := rows.Scan(&rev, &snap); err != nil {
				rows.Close()
				return nil, err
			}
			snaps[rev] = append(json.RawMessage(nil), snap...)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	items := make([]storedScan, 0, len(scanned))
	for _, item := range scanned {
		next, err := HydratePayload(item.row.Payload, func(revision string) (json.RawMessage, bool, error) {
			snap, ok := snaps[revision]
			if !ok {
				return nil, false, nil
			}
			return snap, true, nil
		})
		if err != nil {
			return nil, err
		}
		item.row.Payload = next
		items = append(items, item)
	}
	return items, nil
}

func (h Host) decideCandidates(w http.ResponseWriter, r *http.Request, p access.Principal, id string, base int64, raw json.RawMessage, rowPayload, cardPayload []byte) {
	var decisions []struct {
		Index  int  `json:"index"`
		Accept bool `json:"accept"`
	}
	if err := json.Unmarshal(raw, &decisions); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	if h.core() == nil {
		writeErr(w, http.StatusInternalServerError, "服务暂不可用", "internal")
		return
	}
	var item storedScan
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		schema, revision, err := h.schemaFor(r, tx, cardPayload)
		if err != nil {
			return err
		}
		body, err := json.Marshal(map[string]any{
			"card": json.RawMessage(cardPayload), "nowMs": h.clock().UnixMilli(),
			"row": json.RawMessage(rowPayload), "decisions": decisions,
		})
		if err != nil {
			return err
		}
		out, err := h.core().Call(r.Context(), OpDecideCandidates, schema, body)
		if err != nil {
			status, message, code := refuseCore(err)
			return rowRefuse{status, message, code}
		}
		edited, err := decodeRowEdit(out)
		if err != nil {
			return coreUnreadable("OpDecideCandidates", err)
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE listing_rows
			SET payload = $4::jsonb,
			    validation_state = $5,
			    schema_revision = COALESCE(NULLIF($6, ''), schema_revision),
			    revision = revision + 1,
			    updated_by = NULLIF($7, 0),
			    updated_at = clock_timestamp()
			WHERE org_id = $1 AND id = $2::uuid AND revision = $3`,
			p.OrgID, id, base, string(edited.Row), factState(edited.Fact), revision, p.UserID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return rowRefuse{http.StatusConflict, "商品行已被他人更新，请刷新后重试", "conflict"}
		}
		item, err = scanStoredRow(tx.QueryRow(r.Context(), `SELECT `+rowColumns+` FROM listing_rows WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, id))
		if err != nil {
			return err
		}
		item, err = h.withSnapshot(r.Context(), tx, item)
		return err
	})
	h.finishRow(w, err, item)
}

func (h Host) clearGenerated(w http.ResponseWriter, r *http.Request, p access.Principal, id string, base int64, rowPayload, cardPayload []byte) {
	var item storedScan
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		var submission, content, media string
		var active bool
		if err := tx.QueryRow(r.Context(), `
			SELECT submission_state, content_state, media_state,
			       EXISTS (
			         SELECT 1 FROM jobs
			         WHERE org_id = $1 AND aggregate_id = $2::uuid AND aggregate_type = 'listing_row'
			           AND cancel_requested_at IS NULL
			           AND state IN ('queued', 'retry_wait', 'running')
			           AND kind IN ('ai.recognize', 'media.render', 'media.upload')
			       )
			FROM listing_rows WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, id).
			Scan(&submission, &content, &media, &active); err != nil {
			return err
		}
		switch submission {
		case "none", "cancelled", "rejected":
		default:
			return rowRefuse{http.StatusUnprocessableEntity, "已上架或待对账商品不能清空生成内容", "validation"}
		}
		if content == "recognizing" || media == "processing" || active {
			return rowRefuse{http.StatusUnprocessableEntity, "所选商品仍在识别、切片或上传，请完成后再清空", "validation"}
		}
		if h.core() == nil {
			return errors.New("listing core unavailable")
		}
		schema, revision, err := h.schemaFor(r, tx, cardPayload)
		if err != nil {
			return err
		}
		body, err := json.Marshal(map[string]any{
			"card": json.RawMessage(cardPayload), "nowMs": h.clock().UnixMilli(),
			"row": json.RawMessage(rowPayload), "edit": map[string]any{"kind": "clearGeneratedContent"},
		})
		if err != nil {
			return err
		}
		out, err := h.core().Call(r.Context(), OpEditRow, schema, body)
		if err != nil {
			status, message, code := refuseCore(err)
			return rowRefuse{status, message, code}
		}
		edited, err := decodeRowEdit(out)
		if err != nil {
			return coreUnreadable("OpEditRow", err)
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE listing_rows
			SET payload = $4::jsonb,
			    validation_state = $5,
			    build_state = 'stale',
			    schema_revision = COALESCE(NULLIF($6, ''), schema_revision),
			    revision = revision + 1,
			    updated_by = NULLIF($7, 0),
			    updated_at = clock_timestamp(),
			    content_state = COALESCE(NULLIF($8, ''), content_state),
			    media_state = COALESCE(NULLIF($9, ''), media_state),
			    submission_state = COALESCE(NULLIF($10, ''), submission_state)
			WHERE org_id = $1 AND id = $2::uuid AND revision = $3`,
			p.OrgID, id, base, string(edited.Row), factState(edited.Fact), revision, p.UserID,
			textOrEmpty(edited.Invalidation.Content), textOrEmpty(edited.Invalidation.Media), textOrEmpty(edited.Invalidation.Submission))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return rowRefuse{http.StatusConflict, "商品行已被他人更新，请刷新后重试", "conflict"}
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE jobs SET state = 'cancelled',
			    cancel_requested_at = clock_timestamp(),
			    updated_at = clock_timestamp(),
			    idempotency_key = idempotency_key || ':cleared:' || id::text
			WHERE org_id = $1 AND aggregate_id = $2::uuid
			  AND aggregate_type = 'listing_row'
			  AND kind = 'ai.recognize'
			  AND state = 'failed'`, p.OrgID, id); err != nil {
			return err
		}
		item, err = scanStoredRow(tx.QueryRow(r.Context(), `SELECT `+rowColumns+` FROM listing_rows WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, id))
		if err != nil {
			return err
		}
		item, err = h.withSnapshot(r.Context(), tx, item)
		return err
	})
	if refuse, ok := err.(rowRefuse); ok && refuse.status == http.StatusConflict {
		jsonwire.Write(w, http.StatusConflict, struct {
			Error string `json:"error"`
			Code  string `json:"code"`
			Clear bool   `json:"clearGeneratedContent"`
		}{Error: refuse.message, Code: "conflict", Clear: true})
		return
	}
	h.finishRow(w, err, item)
}

func (h Host) mergeRowFields(w http.ResponseWriter, r *http.Request, p access.Principal, id string, base int64, fields map[string]json.RawMessage, rowPayload []byte) {
	patch := json.RawMessage(`{}`)
	if raw, ok := fields["changes"]; ok && string(raw) != "null" {
		patch = raw
	} else if raw, ok := fields["payload"]; ok && string(raw) != "null" {
		patch = raw
	}
	if len(bytes.TrimSpace(patch)) == 0 || patch[0] != '{' {
		writeErr(w, http.StatusBadRequest, "changes/payload 必须是对象", "validation")
		return
	}
	if msg := protectSections(rowPayload, fields, patch); msg != "" {
		writeErr(w, http.StatusBadRequest, msg, "validation")
		return
	}
	storeSet := false
	store := ""
	if raw, ok := fields["storeId"]; ok {
		storeSet = true
		if string(raw) != "null" {
			var text string
			if json.Unmarshal(raw, &text) != nil {
				writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
				return
			}
			bound, ok := h.visibleStore(w, r, p.OrgID, p.UserID, &text)
			if !ok {
				return
			}
			store = bound
		}
	}
	var item storedScan
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE listing_rows
			SET payload = payload || $4::jsonb,
			    revision = revision + 1,
			    updated_by = NULLIF($5, 0),
			    updated_at = clock_timestamp()
			WHERE org_id = $1 AND id = $2::uuid AND revision = $3`,
			p.OrgID, id, base, string(patch), p.UserID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return rowRefuse{http.StatusConflict, "商品行已被他人更新，请刷新后重试", "conflict"}
		}
		if storeSet {
			tag, err = tx.Exec(r.Context(), `
				UPDATE listing_rows
				SET store_id = NULLIF($4, '')::uuid,
				    revision = revision + 1,
				    updated_by = NULLIF($5, 0),
				    updated_at = clock_timestamp()
				WHERE org_id = $1 AND id = $2::uuid AND revision = $3`,
				p.OrgID, id, base+1, store, p.UserID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return rowRefuse{http.StatusConflict, "商品行已被他人更新，请刷新后重试", "conflict"}
			}
		}
		item, err = scanStoredRow(tx.QueryRow(r.Context(), `SELECT `+rowColumns+` FROM listing_rows WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, id))
		if err != nil {
			return err
		}
		item, err = h.withSnapshot(r.Context(), tx, item)
		return err
	})
	h.finishRow(w, err, item)
}

func protectSections(row []byte, fields map[string]json.RawMessage, patch json.RawMessage) string {
	stored := map[string]json.RawMessage{}
	_ = json.Unmarshal(row, &stored)
	var changes map[string]json.RawMessage
	_ = json.Unmarshal(patch, &changes)
	for _, key := range []string{"ai", "fieldOrigins", "handEditedKeys", "supplierProductId"} {
		if raw, ok := changes[key]; ok && !jsonEqual(raw, stored[key]) {
			return "识别证据与字段来源由服务端维护，请使用候选确认或草稿编辑"
		}
		if sent, ok := fields["payload"]; ok && string(sent) != "null" {
			var body map[string]json.RawMessage
			if json.Unmarshal(sent, &body) == nil {
				if raw, ok := body[key]; ok && !jsonEqual(raw, stored[key]) {
					return "识别证据与字段来源由服务端维护，请使用候选确认或草稿编辑"
				}
			}
		}
	}
	if raw, ok := changes["draft"]; ok && !jsonEqual(raw, stored["draft"]) {
		return "草稿值请通过 draft 编辑字段提交"
	}
	return ""
}

func jsonEqual(a, b json.RawMessage) bool {
	if len(bytes.TrimSpace(a)) == 0 && len(bytes.TrimSpace(b)) == 0 {
		return true
	}
	var left, right any
	if json.Unmarshal(a, &left) != nil || json.Unmarshal(b, &right) != nil {
		return bytes.Equal(bytes.TrimSpace(a), bytes.TrimSpace(b))
	}
	lb, _ := json.Marshal(left)
	rb, _ := json.Marshal(right)
	return bytes.Equal(lb, rb)
}

// rowEdit is what a row-mutating core call (OpEditRow, OpDecideCandidates)
// returns: the row the core rewrote, the validation fact it computed, and which
// derived states the edit invalidated. A nil state pointer means the op left
// that column alone.
type rowEdit struct {
	Row          json.RawMessage `json:"row"`
	Fact         string          `json:"fact"`
	Invalidation struct {
		Content    *string `json:"contentState"`
		Media      *string `json:"mediaState"`
		Submission *string `json:"submissionState"`
	} `json:"invalidation"`
}

// decodeRowEdit reads what a row-mutating core call returned. An empty row is
// as unreadable as a body that does not parse: the caller has nothing to write.
func decodeRowEdit(out []byte) (rowEdit, error) {
	var edited rowEdit
	if err := json.Unmarshal(out, &edited); err != nil {
		return rowEdit{}, err
	}
	if len(edited.Row) == 0 {
		return rowEdit{}, errors.New("listing-core returned no row")
	}
	return edited, nil
}

func factState(fact string) string {
	switch strings.ToLower(fact) {
	case "passed":
		return "passed"
	case "blocked":
		return "blocked"
	default:
		return "stale"
	}
}

func (h Host) finishRow(w http.ResponseWriter, err error, item storedScan) {
	var refuse rowRefuse
	if errors.As(err, &refuse) {
		writeErr(w, refuse.status, refuse.message, refuse.code)
		return
	}
	if err != nil {
		writeDB(w, err)
		return
	}
	writeRow(w, item, nil)
}
