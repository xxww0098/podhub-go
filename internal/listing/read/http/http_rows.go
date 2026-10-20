package readhttp

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

func (h Host) createRow(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	raw, err := readBody(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	var body createRowBody
	if err := decode(raw, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	if err := CreateKeyPair(body.CreateKey, body.RequestFingerprint); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error(), "validation")
		return
	}
	if body.Source.SHA256 == "" {
		writeErr(w, http.StatusBadRequest, "source.sha256 必填", "validation")
		return
	}
	cardID, ok := CanonicalUUID(body.CardID)
	if !ok {
		writeErr(w, http.StatusBadRequest, "cardId 无效", "validation")
		return
	}
	h.finishCreateRow(w, r, p, cardID, body)
}

type createRowBody struct {
	CardID  string  `json:"cardId"`
	StoreID *string `json:"storeId"`
	Source  struct {
		SHA256   string `json:"sha256"`
		FileName string `json:"fileName"`
	} `json:"source"`
	Draft              json.RawMessage `json:"draft"`
	CreateKey          *string         `json:"createKey"`
	RequestFingerprint *string         `json:"requestFingerprint"`
	Association        json.RawMessage `json:"association"`
}

func (h Host) getRow(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "商品行编号无效", "validation")
		return
	}
	item, err := h.loadRow(r, p.OrgID, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "商品行不存在", "not_found")
		return
	}
	if err != nil {
		writeDB(w, err)
		return
	}
	writeRow(w, item, nil)
}

func (h Host) patchRow(w http.ResponseWriter, r *http.Request) {
	if crossOriginWrite(r) {
		writeCSRF(w)
		return
	}
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "商品行编号无效", "validation")
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
		case "baseRevision", "mode", "payload", "changes", "draft", "fillBlank", "clearGeneratedContent", "candidateDecisions", "storeId":
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
	if mode, ok := fields["mode"]; ok && string(mode) != "null" {
		var text string
		if err := json.Unmarshal(mode, &text); err != nil || (text != "full" && text != "light") {
			writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
			return
		}
	}
	if !patchTypesOK(fields) {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	if flagTrue(fields, "fillBlank") {
		doc, ok := clientChanges(fields)
		if !ok || doc == nil {
			writeErr(w, http.StatusBadRequest, "changes/payload 必须是对象", "validation")
			return
		}
		if msg := fillExclusion(fields); msg != "" {
			writeErr(w, http.StatusBadRequest, msg, "validation")
			return
		}
		if !fieldSome(fields, "draft") {
			h.fillBlankRow(w, r, p, id, base, fields)
			return
		}
	}
	var revision int64
	var rowPayload, cardPayload []byte
	err = h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT r.revision, r.payload, c.payload
			FROM listing_rows r
			JOIN listing_cards c ON c.org_id = r.org_id AND c.id = r.card_id
			WHERE r.org_id = $1 AND r.id = $2::uuid`, p.OrgID, id).Scan(&revision, &rowPayload, &cardPayload)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "商品行不存在", "not_found")
		return
	}
	if err != nil {
		status, message, code := dbStatus(err)
		writeErr(w, status, message, code)
		return
	}
	if revision != base {
		writeRowConflict(w, revision, rowPayload, base, fields)
		return
	}
	draft := storedDraft(rowPayload)
	if sent, ok := fields["draft"]; ok && string(sent) != "null" {
		draft = sent
	}
	if err := h.rejectTags(r, cardPayload, draft); err != nil {
		var refusal tagRefusal
		if errors.As(err, &refusal) {
			writeErr(w, refusal.status, refusal.message, refusal.code)
			return
		}
		status, message, code := dbStatus(err)
		writeErr(w, status, message, code)
		return
	}
	h.finishPatchRow(w, r, p, id, base, fields, rowPayload, cardPayload)
}

type tagRefusal struct {
	status  int
	message string
	code    string
}

func (t tagRefusal) Error() string { return t.message }

func (h Host) rejectTags(r *http.Request, cardPayload, draft []byte) error {
	cat, typ, lang, ok := categoryOf(cardPayload)
	if !ok {
		return tagRefusal{http.StatusConflict, "该类目尚未同步，请先同步类目字段后重试", "schema_sync_required"}
	}
	if h.Pool == nil {
		return errors.New("database unavailable")
	}
	var fields []byte
	err := h.Pool.QueryRow(r.Context(), `
		SELECT fields FROM ozon_category_current
		WHERE description_category_id = $1 AND type_id = $2 AND ($3 = '' OR language = $3)
		LIMIT 1`, cat, typ, lang).Scan(&fields)
	if errors.Is(err, pgx.ErrNoRows) {
		return tagRefusal{http.StatusConflict, "该类目尚未同步，请先同步类目字段后重试", "schema_sync_required"}
	}
	if err != nil {
		return tagRefusal{http.StatusServiceUnavailable, "规则表读取失败，已拒绝通过", "rules_unavailable"}
	}
	tokens, err := SearchTagTokens(fields, draft)
	if err != nil {
		return tagRefusal{http.StatusServiceUnavailable, "规则表读取失败，已拒绝通过", "rules_unavailable"}
	}
	if len(tokens) == 0 {
		return nil
	}
	if h.LoadRules == nil || h.Engine == nil {
		return tagRefusal{http.StatusServiceUnavailable, "规则表读取失败，已拒绝通过", "rules_unavailable"}
	}
	rules, err := h.LoadRules(r.Context())
	if err != nil {
		return tagRefusal{http.StatusServiceUnavailable, "规则表读取失败，已拒绝通过", "rules_unavailable"}
	}
	save, err := ForbidSave(r.Context(), h.Engine, tokens, rules)
	if err != nil {
		return tagRefusal{http.StatusServiceUnavailable, "规则未能执行，已拒绝通过", "rules_unavailable"}
	}
	if !save.OK {
		return tagRefusal{http.StatusBadRequest, save.Message, "validation"}
	}
	return nil
}

func categoryOf(payload []byte) (int64, int64, string, bool) {
	var body map[string]any
	if err := json.Unmarshal(payload, &body); err != nil {
		return 0, 0, "", false
	}
	cat, ok1 := jsonInt(body["descriptionCategoryId"])
	typ, ok2 := jsonInt(body["typeId"])
	if !ok1 || !ok2 || cat <= 0 || typ <= 0 {
		return 0, 0, "", false
	}
	lang, _ := body["language"].(string)
	return cat, typ, lang, true
}

func jsonInt(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		return int64(n), true
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	default:
		return 0, false
	}
}

func storedDraft(payload []byte) []byte {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(payload, &body); err != nil {
		return nil
	}
	raw := body["draft"]
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return raw
}
