package readhttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

func (h Host) createCard(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	raw, err := readBody(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	var body createCardBody
	if err := decode(raw, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	refusal, proceed := ValidateCreate(CreateCard{
		Title: body.Title, StoreID: body.StoreID, Payload: body.Payload, CreateMode: body.CreateMode,
		ApplyActivePack: body.ApplyActivePack, FieldPackID: body.FieldPackID, SourceCardID: body.SourceCardID,
		SupplierProductID: body.SupplierProductID,
	})
	if !proceed {
		writeErr(w, http.StatusBadRequest, refusal.Message, "validation")
		return
	}
	h.finishCreate(w, r, p.UserID, p.OrgID, body.CreateMode, strings.TrimSpace(body.Title), body.StoreID, body.Payload, body.SourceCardID, body.SupplierProductID)
}

type createCardBody struct {
	Title             string          `json:"title"`
	StoreID           *string         `json:"storeId"`
	Payload           json.RawMessage `json:"payload"`
	CreateMode        string          `json:"createMode"`
	ApplyActivePack   bool            `json:"applyActivePack"`
	FieldPackID       *string         `json:"fieldPackId"`
	SourceCardID      *string         `json:"sourceCardId"`
	SupplierProductID *string         `json:"supplierProductId"`
}

func (h Host) copyCard(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "cardId 无效", "validation")
		return
	}
	h.copyFrom(w, r, p.UserID, p.OrgID, "", id, false)
}

func (h Host) patchCard(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "cardId 无效", "validation")
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
	for key := range fields {
		switch key {
		case "baseRevision", "title", "payload", "storeId", "fieldPackId":
		default:
			writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
			return
		}
	}
	baseRaw, ok := fields["baseRevision"]
	if !ok {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	var base int64
	if err := json.Unmarshal(baseRaw, &base); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	if pack, ok := fields["fieldPackId"]; ok && string(pack) != "null" {
		writeErr(w, http.StatusBadRequest, "不再支持字段包套用", "validation")
		return
	}
	_, storeSent := fields["storeId"]
	payload, payloadSent := fields["payload"]
	needsCore := storeSent || (payloadSent && string(payload) != "null")
	var title string
	if rawTitle, ok := fields["title"]; ok && string(rawTitle) != "null" {
		if err := json.Unmarshal(rawTitle, &title); err != nil {
			writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
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
		if item.supplier {
			writeErr(w, http.StatusBadRequest, "供应商商品方案配置由在线平台货源管理，不能在方案中修改", "validation")
			return
		}
	}
	if needsCore {
		h.applyCardWrite(w, r, p, id, base, title, fields)
		return
	}
	var updated cardRow
	var outcome string
	err = h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		row := tx.QueryRow(r.Context(), `
			UPDATE listing_cards
			SET title = CASE WHEN $4 = '' THEN title ELSE $4 END,
			    payload = CASE WHEN $5::text = 'null' THEN payload ELSE $5::jsonb END,
			    store_id = CASE WHEN $7 THEN NULLIF($8, '')::uuid ELSE store_id END,
			    revision = revision + 1,
			    updated_by = NULLIF($6, 0),
			    updated_at = clock_timestamp()
			WHERE org_id = $1 AND id = $2::uuid AND revision = $3
			RETURNING `+cardSelect, p.OrgID, id, base, title, "null", p.UserID, false, "")
		item, scanErr := scanCard(row)
		if scanErr == nil {
			updated = item
			outcome = "ok"
			return nil
		}
		if !errors.Is(scanErr, pgx.ErrNoRows) {
			return scanErr
		}
		var exists int
		err := tx.QueryRow(r.Context(), `SELECT 1 FROM listing_cards WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, id).Scan(&exists)
		if errors.Is(err, pgx.ErrNoRows) {
			outcome = "missing"
			return errStop
		}
		if err != nil {
			return err
		}
		outcome = "conflict"
		return errStop
	})
	if outcome == "missing" {
		writeErr(w, http.StatusNotFound, "上架方案不存在", "not_found")
		return
	}
	if outcome == "conflict" {
		writeErr(w, http.StatusConflict, "上架方案已被他人更新，请刷新后重试", "conflict")
		return
	}
	if err != nil {
		status, message, code := dbStatus(err)
		writeErr(w, status, message, code)
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data cardView `json:"data"`
	}{Data: updated.view})
}

var errStop = errors.New("stop")

func (h Host) applyCardWrite(w http.ResponseWriter, r *http.Request, p access.Principal, id string, base int64, title string, fields map[string]json.RawMessage) {
	item, err := h.loadCard(r, p.OrgID, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "上架方案不存在", "not_found")
		return
	}
	if err != nil {
		writeDB(w, err)
		return
	}
	if item.view.Revision != base {
		writeErr(w, http.StatusConflict, "上架方案已被他人更新，请刷新后重试", "conflict")
		return
	}
	storeSent := false
	storeValue := ""
	if raw, ok := fields["storeId"]; ok {
		storeSent = true
		if string(raw) != "null" {
			var text string
			if err := json.Unmarshal(raw, &text); err != nil {
				writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
				return
			}
			bound, ok := h.visibleStore(w, r, p.OrgID, p.UserID, &text)
			if !ok {
				return
			}
			storeValue = bound
		}
	}
	payloadSQL := "null"
	if raw, ok := fields["payload"]; ok && string(raw) != "null" {
		if item.supplier {
			merged, msg, ok := supplierOverlay(item.payload, raw)
			if !ok {
				writeErr(w, http.StatusBadRequest, msg, "validation")
				return
			}
			body, err := PrepareCard(merged, defaultsOf(item.payload))
			if err != nil {
				writeDoc(w, err)
				return
			}
			payloadSQL = string(body)
		} else {
			if payloadHasSupplier(raw) {
				writeErr(w, http.StatusBadRequest, "请从平台货源选择规格创建方案", "validation")
				return
			}
			body, err := PrepareCard(raw, defaultsOf(item.payload))
			if err != nil {
				writeDoc(w, err)
				return
			}
			payloadSQL = string(body)
		}
	}
	var updated cardRow
	var outcome string
	err = h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		row := tx.QueryRow(r.Context(), `
			UPDATE listing_cards
			SET title = CASE WHEN $4 = '' THEN title ELSE $4 END,
			    payload = CASE WHEN $5::text = 'null' THEN payload ELSE $5::jsonb END,
			    store_id = CASE WHEN $7 THEN NULLIF($8, '')::uuid ELSE store_id END,
			    revision = revision + 1,
			    updated_by = NULLIF($6, 0),
			    updated_at = clock_timestamp()
			WHERE org_id = $1 AND id = $2::uuid AND revision = $3
			RETURNING `+cardSelect, p.OrgID, id, base, title, payloadSQL, p.UserID, storeSent, storeValue)
		scanned, scanErr := scanCard(row)
		if scanErr == nil {
			updated = scanned
			outcome = "ok"
			return nil
		}
		if !errors.Is(scanErr, pgx.ErrNoRows) {
			return scanErr
		}
		outcome = "conflict"
		return errStop
	})
	if outcome == "conflict" {
		writeErr(w, http.StatusConflict, "上架方案已被他人更新，请刷新后重试", "conflict")
		return
	}
	if err != nil {
		writeDB(w, err)
		return
	}
	writeCard(w, updated)
}

func supplierOverlay(stored, patch json.RawMessage) (json.RawMessage, string, bool) {
	const denied = "供应商商品方案配置由在线平台货源管理，不能在方案中修改"
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(patch, &obj); err != nil || len(obj) == 0 {
		return nil, denied, false
	}
	for key, raw := range obj {
		switch key {
		case "queue", "targetStoreId", "defaults", "psdTemplateAssetId", "psdTemplateSha256", "psdTemplateFileName":
		default:
			return nil, denied, false
		}
		if key == "psdTemplateAssetId" || key == "psdTemplateSha256" || key == "psdTemplateFileName" {
			var text string
			if json.Unmarshal(raw, &text) == nil && len(text) > 512 {
				return nil, "PSD 模板绑定过长", false
			}
		}
		if key == "defaults" && !supplierDefaults(raw) {
			return nil, denied, false
		}
	}
	var base map[string]json.RawMessage
	if err := json.Unmarshal(stored, &base); err != nil || base == nil {
		return nil, denied, false
	}
	for key, raw := range obj {
		base[key] = raw
	}
	out, err := json.Marshal(base)
	if err != nil {
		return nil, denied, false
	}
	return out, "", true
}

func supplierDefaults(raw json.RawMessage) bool {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return false
	}
	for key, value := range obj {
		switch key {
		case "values", "cleared":
			if !supplierDefaultKeys(value) {
				return false
			}
		case "complexValues", "complex_values":
			trimmed := bytes.TrimSpace(value)
			if len(trimmed) > 0 && string(trimmed) != "[]" && string(trimmed) != "null" {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func supplierDefaultKeys(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return true
	}
	if trimmed[0] == '[' {
		var keys []string
		if json.Unmarshal(raw, &keys) != nil {
			return false
		}
		for _, key := range keys {
			if !supplierDefaultKey(key) {
				return false
			}
		}
		return true
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil {
		return false
	}
	for key := range obj {
		if !supplierDefaultKey(key) {
			return false
		}
	}
	return true
}

func supplierDefaultKey(key string) bool {
	switch key {
	case "price", "old_price", "attribute_7109", "attribute_11254":
		return true
	default:
		return false
	}
}

func promptSHA(payload []byte) string {
	var body map[string]json.RawMessage
	if json.Unmarshal(payload, &body) != nil {
		return ""
	}
	raw := body["aiPromptSha256"]
	var text string
	if json.Unmarshal(raw, &text) != nil {
		return ""
	}
	return text
}

func (h Host) deleteCard(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "cardId 无效", "validation")
		return
	}
	var deleted int64
	var found bool
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM listing_rows WHERE org_id = $1 AND card_id = $2::uuid`, p.OrgID, id).Scan(&deleted); err != nil {
			return err
		}
		tag, err := tx.Exec(r.Context(), `DELETE FROM listing_cards WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		found = true
		if _, err := tx.Exec(r.Context(), `DELETE FROM listing_rows WHERE org_id = $1 AND card_id = $2::uuid`, p.OrgID, id); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		status, message, code := dbStatus(err)
		writeErr(w, status, message, code)
		return
	}
	if !found {
		writeErr(w, http.StatusNotFound, "上架方案不存在", "not_found")
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data struct {
			ID          string `json:"id"`
			DeletedRows int64  `json:"deletedRows"`
		} `json:"data"`
	}{Data: struct {
		ID          string `json:"id"`
		DeletedRows int64  `json:"deletedRows"`
	}{ID: id, DeletedRows: deleted}})
}

func (h Host) snapshotCard(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "cardId 无效", "validation")
		return
	}
	var cursor int64
	var found bool
	var views []RowView
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT COALESCE((SELECT seq FROM listing_card_cursors WHERE org_id = $1 AND card_id = $2::uuid), 0)
			FROM listing_cards WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, id).Scan(&cursor)
		if err != nil {
			return err
		}
		found = true
		listed, err := tx.Query(r.Context(), `
			SELECT id::text, card_id::text, store_id::text, revision, view_revision,
			       content_state, media_state, validation_state, submission_state,
			       payload, build_state, build_sources, updated_at
			FROM listing_rows
			WHERE org_id = $1 AND card_id = $2::uuid
			ORDER BY queue_position ASC, created_at ASC, id ASC`, p.OrgID, id)
		if err != nil {
			return err
		}
		defer listed.Close()
		for listed.Next() {
			item, err := scanStoredRow(listed)
			if err != nil {
				return err
			}
			views = append(views, ProjectRow(item.row))
		}
		return listed.Err()
	})
	if errors.Is(err, pgx.ErrNoRows) || !found && err == nil {
		writeErr(w, http.StatusNotFound, "上架方案不存在", "not_found")
		return
	}
	if err != nil {
		writeDB(w, err)
		return
	}
	if views == nil {
		views = []RowView{}
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data struct {
			WorkspaceID string          `json:"workspaceId"`
			CardID      string          `json:"cardId"`
			Cursor      string          `json:"cursor"`
			Rows        []RowView       `json:"rows"`
			Summary     SnapshotSummary `json:"summary"`
		} `json:"data"`
	}{Data: struct {
		WorkspaceID string          `json:"workspaceId"`
		CardID      string          `json:"cardId"`
		Cursor      string          `json:"cursor"`
		Rows        []RowView       `json:"rows"`
		Summary     SnapshotSummary `json:"summary"`
	}{
		WorkspaceID: strings.TrimSpace(itoaOrg(p.OrgID)),
		CardID:      id,
		Cursor:      itoaOrg(cursor),
		Rows:        views,
		Summary:     SummaryOf(views),
	}})
}

func itoaOrg(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
