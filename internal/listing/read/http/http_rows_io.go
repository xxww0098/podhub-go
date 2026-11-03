package readhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	catalogcontract "github.com/xxww0098/podhub-go/internal/catalog/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

const rowColumns = `id::text, card_id::text, store_id::text, revision, view_revision,
	content_state, media_state, validation_state, submission_state,
	payload, build_state, build_sources, updated_at,
	(SELECT i.submission_receipt FROM submission_intents i
	  WHERE i.org_id = listing_rows.org_id AND i.listing_row_id = listing_rows.id
	    AND i.row_revision = listing_rows.revision
	  ORDER BY i.created_at DESC, i.id DESC LIMIT 1),
	EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = listing_rows.org_id AND j.aggregate_id = listing_rows.id
		AND j.aggregate_type = 'listing_row' AND j.kind = 'ai.recognize'
		AND j.cancel_requested_at IS NULL AND j.state IN ('queued','retry_wait','running')),
	EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = listing_rows.org_id AND j.aggregate_id = listing_rows.id
		AND j.aggregate_type = 'listing_row' AND j.kind = 'media.upload'
		AND j.cancel_requested_at IS NULL AND j.state IN ('queued','retry_wait','running')),
	EXISTS (SELECT 1 FROM jobs j WHERE j.org_id = listing_rows.org_id AND j.aggregate_id = listing_rows.id
		AND j.aggregate_type = 'listing_row' AND j.kind = 'media.render'
		AND j.cancel_requested_at IS NULL AND j.state IN ('queued','retry_wait','running')),
	(SELECT jsonb_build_object('row_revision',i.row_revision,'state',i.state,
		'last_error_code',i.last_error_code,'submission_issues',i.submission_issues,
		'reconciliation_outcome',i.reconciliation_outcome,'external_task_id',i.external_task_id)
	 FROM submission_intents i
	 WHERE i.org_id=listing_rows.org_id AND i.listing_row_id=listing_rows.id
	 ORDER BY i.row_revision DESC,i.created_at DESC,i.id DESC LIMIT 1)`

const schemaTTLMS = int64(24 * 60 * 60 * 1000)

type storedScan struct {
	row    StoredRow
	micros int64
}

func scanStoredRow(row pgx.Row) (storedScan, error) {
	var (
		item    StoredRow
		updated time.Time
		sources []byte
	)
	err := row.Scan(
		&item.ID, &item.CardID, &item.StoreID, &item.Revision, &item.ViewRevision,
		&item.Content, &item.Media, &item.Validation, &item.Submission,
		&item.Payload, &item.BuildState, &sources, &updated, &item.Receipt,
		&item.RecognizeJob, &item.UploadJob, &item.SliceJob,
		&item.LatestIntent,
	)
	if err != nil {
		return storedScan{}, err
	}
	item.BuildSources = sources
	item.UpdatedAtMs = updated.UnixMilli()
	return storedScan{row: item, micros: updated.UnixMicro()}, nil
}

func (h Host) loadRow(r *http.Request, org int64, id string) (storedScan, error) {
	var item storedScan
	err := h.withOrg(r.Context(), org, func(tx pgx.Tx) error {
		scanned, err := scanStoredRow(tx.QueryRow(r.Context(), `
			SELECT `+rowColumns+` FROM listing_rows WHERE org_id = $1 AND id = $2::uuid`, org, id))
		if err != nil {
			return err
		}
		item, err = h.withSnapshot(r.Context(), tx, scanned)
		return err
	})
	return item, err
}

func (h Host) listRows(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cardFilter := strings.TrimSpace(q.Get("cardId"))
	if q.Has("cardId") && cardFilter != "" {
		if _, ok := CanonicalUUID(cardFilter); !ok {
			writeErr(w, http.StatusBadRequest, "cardId 无效", "validation")
			return
		}
	}
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	limit, ok := ParseLimit(q.Get("limit"), q.Has("limit"))
	if !ok {
		writeErr(w, http.StatusBadRequest, "limit 无效", "validation")
		return
	}
	fetch := limit + 1
	if fetch > 101 {
		fetch = 101
	}
	var items []storedScan
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		var listed pgx.Rows
		var err error
		if cardFilter != "" {
			seen := int64(0)
			if raw := strings.TrimSpace(q.Get("cursor")); raw != "" {
				if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
					seen = n
				}
			}
			listed, err = tx.Query(r.Context(), `
				SELECT `+rowColumns+`
				FROM listing_rows
				WHERE org_id = $1 AND card_id = $2::uuid
				ORDER BY queue_position ASC, created_at ASC, id ASC
				LIMIT $3 OFFSET $4`, p.OrgID, cardFilter, fetch, seen)
		} else {
			micros, afterID := ParseCursor(q.Get("cursor"))
			category := strings.TrimSpace(q.Get("categoryKey"))
			sql := `SELECT ` + rowColumns + ` FROM listing_rows WHERE org_id = $1`
			args := []any{p.OrgID}
			if micros != 0 {
				args = append(args, micros, afterID)
				sql += ` AND (updated_at, id) < ((TIMESTAMPTZ 'epoch' + ($2::bigint || ' microseconds')::interval), $3::uuid)`
			}
			if category != "" {
				args = append(args, category)
				sql += ` AND category_key = $` + strconv.Itoa(len(args))
			}
			args = append(args, fetch)
			sql += ` ORDER BY updated_at DESC, id DESC LIMIT $` + strconv.Itoa(len(args))
			listed, err = tx.Query(r.Context(), sql, args...)
		}
		if err != nil {
			return err
		}
		defer listed.Close()
		var scanned []storedScan
		for listed.Next() {
			item, err := scanStoredRow(listed)
			if err != nil {
				return err
			}
			scanned = append(scanned, item)
		}
		if err := listed.Err(); err != nil {
			return err
		}
		// Hydrate after the list cursor closes. A snapshot lookup on the
		// same connection while rows are open is "conn busy".
		listed.Close()
		items, err = h.hydrateRows(r.Context(), tx, scanned)
		return err
	})
	if err != nil {
		writeDB(w, err)
		return
	}
	var next *string
	if int64(len(items)) > limit {
		items = items[:limit]
		if cardFilter != "" {
			seen := int64(0)
			if raw := strings.TrimSpace(q.Get("cursor")); raw != "" {
				if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
					seen = n
				}
			}
			cursor := strconv.FormatInt(seen+limit, 10)
			next = &cursor
		} else {
			last := items[len(items)-1]
			cursor := FormatCursor(last.micros, last.row.ID)
			next = &cursor
		}
	}
	views := make([]RowView, 0, len(items))
	for _, item := range items {
		views = append(views, ProjectRow(item.row))
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data struct {
			Items      []RowView `json:"items"`
			NextCursor *string   `json:"nextCursor,omitempty"`
		} `json:"data"`
	}{Data: struct {
		Items      []RowView `json:"items"`
		NextCursor *string   `json:"nextCursor,omitempty"`
	}{Items: views, NextCursor: next}})
}

func writeRow(w http.ResponseWriter, item storedScan, created *bool) {
	body := struct {
		Data    RowView `json:"data"`
		Created *bool   `json:"created,omitempty"`
	}{Data: ProjectRow(item.row), Created: created}
	jsonwire.Write(w, http.StatusOK, body)
}

func writeRowConflict(w http.ResponseWriter, revision int64, payload []byte, base int64, fields map[string]json.RawMessage) {
	server := json.RawMessage(payload)
	if !json.Valid(server) || len(server) == 0 {
		server = json.RawMessage(`{}`)
	}
	changes := json.RawMessage(`{}`)
	if raw, ok := fields["changes"]; ok && string(raw) != "null" {
		changes = raw
	} else if raw, ok := fields["draft"]; ok && string(raw) != "null" {
		changes = raw
	}
	jsonwire.Write(w, http.StatusConflict, struct {
		Error    string `json:"error"`
		Code     string `json:"code"`
		Conflict struct {
			ServerRevision     int64           `json:"server_revision"`
			ServerPayload      json.RawMessage `json:"server_payload"`
			ClientBaseRevision int64           `json:"client_base_revision"`
			ClientChanges      json.RawMessage `json:"client_changes"`
		} `json:"conflict"`
	}{
		Error: "商品行已被他人更新，请刷新后重试",
		Code:  "conflict",
		Conflict: struct {
			ServerRevision     int64           `json:"server_revision"`
			ServerPayload      json.RawMessage `json:"server_payload"`
			ClientBaseRevision int64           `json:"client_base_revision"`
			ClientChanges      json.RawMessage `json:"client_changes"`
		}{revision, server, base, changes},
	})
}

func (h Host) finishCreateRow(w http.ResponseWriter, r *http.Request, p access.Principal, cardID string, body createRowBody) {
	sha, ok := hex64(body.Source.SHA256)
	if !ok {
		writeErr(w, http.StatusBadRequest, "source.sha256 必须是 64 位十六进制摘要", "validation")
		return
	}
	draftJSON, draftValue, err := canonicalDraft(body.Draft)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "draft 不是有效的上架草稿："+err.Error(), "validation")
		return
	}
	var assoc *associationRequest
	if hasAssociation(body.Association) {
		assoc = &associationRequest{}
		if err := json.Unmarshal(body.Association, assoc); err != nil {
			writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
			return
		}
	}
	storeArg := body.StoreID
	var storeID string
	if storeArg != nil && strings.TrimSpace(*storeArg) != "" {
		bound, ok := h.visibleStore(w, r, p.OrgID, p.UserID, storeArg)
		if !ok {
			return
		}
		storeID = bound
	}
	clientFP := ""
	if body.RequestFingerprint != nil {
		clientFP = *body.RequestFingerprint
	}
	var created storedScan
	var inserted bool
	err = h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		card, err := scanCard(tx.QueryRow(r.Context(), `SELECT `+cardSelect+` FROM listing_cards WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, cardID))
		if err != nil {
			return err
		}
		card.payload, err = projectSupplierCard(r.Context(), tx, card.payload, h.clock().UnixMilli())
		if err != nil {
			return err
		}
		if storeID == "" && card.view.StoreID != nil {
			storeID = *card.view.StoreID
		}
		if assoc != nil {
			if msg := supplierBinding(r, tx, card.payload, *assoc); msg != "" {
				return rowRefuse{http.StatusConflict, msg, "conflict"}
			}
		}
		schema, revision, err := h.schemaFor(r, tx, card.payload)
		if err != nil {
			return err
		}
		key := ""
		if body.CreateKey != nil {
			key = strings.TrimSpace(*body.CreateKey)
		}
		if h.core() == nil {
			return errors.New("listing-core wasm is not loaded")
		}
		id := uuid.NewString()
		seed := seedInput{
			Card: card.payload, Source: map[string]string{"sha256": sha, "fileName": body.Source.FileName},
			Draft: draftValue, Now: uint64(h.clock().UnixMilli()),
		}
		var seeded []byte
		var assocID, model string
		if assoc != nil {
			seeded, assocID, model, err = h.seedAssociated(r.Context(), schema, seed, id, p.OrgID, *assoc)
		} else {
			seeded, err = h.seedPlain(r.Context(), schema, seed)
		}
		if err != nil {
			return err
		}
		fingerprint := ""
		if key != "" {
			fingerprint = CreateFingerprint(cardID, storeID, sha, body.Source.FileName, assocID, model, clientFP, draftJSON)
		}
		var got *string
		err = tx.QueryRow(r.Context(), `
			INSERT INTO listing_rows
			       (id, org_id, card_id, store_id, payload, schema_revision,
			        create_key, create_fingerprint, association_id, model_value, created_by, updated_by)
			VALUES ($1::uuid, $2, $3::uuid, NULLIF($4, '')::uuid, $5::jsonb, NULLIF($6, ''),
			        NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, '')::uuid, $10, NULLIF($11, 0), NULLIF($11, 0))
			ON CONFLICT (org_id, card_id, create_key) WHERE create_key IS NOT NULL
			DO NOTHING
			RETURNING id::text`, id, p.OrgID, cardID, storeID, string(seeded), revision, key, fingerprint, assocID, model, p.UserID).Scan(&got)
		if errors.Is(err, pgx.ErrNoRows) {
			var storedFP string
			err = tx.QueryRow(r.Context(), `
				SELECT COALESCE(create_fingerprint, '')
				FROM listing_rows
				WHERE org_id = $1 AND card_id = $2::uuid AND create_key = $3`, p.OrgID, cardID, key).Scan(&storedFP)
			if err != nil {
				return err
			}
			if storedFP != fingerprint {
				return rowRefuse{http.StatusConflict, "该创建键已用于不同的创建内容，请刷新列表后用新的创建键重试", "conflict"}
			}
			created, err = scanStoredRow(tx.QueryRow(r.Context(), `SELECT `+rowColumns+` FROM listing_rows WHERE org_id = $1 AND card_id = $2::uuid AND create_key = $3`, p.OrgID, cardID, key))
			return err
		}
		if err != nil {
			return err
		}
		inserted = true
		created, err = scanStoredRow(tx.QueryRow(r.Context(), `SELECT `+rowColumns+` FROM listing_rows WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, id))
		return err
	})
	var refuse rowRefuse
	if errors.As(err, &refuse) {
		writeErr(w, refuse.status, refuse.message, refuse.code)
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "上架方案不存在", "not_found")
		return
	}
	if err != nil {
		writeDB(w, err)
		return
	}
	flag := inserted
	writeRow(w, created, &flag)
}

type seedInput struct {
	Card   json.RawMessage   `json:"card"`
	Source map[string]string `json:"source"`
	Draft  json.RawMessage   `json:"suppliedDraft,omitempty"`
	Now    uint64            `json:"nowMs"`
}

// associationRequest is the same-design claim a create request carries. The
// server re-checks it against the Card's supplier binding; listing-core
// derives the identity from it.
type associationRequest struct {
	SupplierSourceID string `json:"supplierSourceId"`
	VariantGroup     string `json:"variantGroup"`
}

// seedPlain runs the ordinary row seed.
func (h Host) seedPlain(ctx context.Context, schema []byte, in seedInput) ([]byte, error) {
	body, err := json.Marshal(in)
	if err != nil {
		return nil, err
	}
	seeded, err := h.core().Call(ctx, OpSeedRow, schema, body)
	if err != nil {
		status, message, code := refuseCore(err)
		return nil, rowRefuse{status, message, code}
	}
	return seeded, nil
}

// seedAssociated runs op 19: the seed plus the fixed 货号, the common 型号 and
// the association id, all derived inside listing-core so Go holds no second
// copy of the formula.
func (h Host) seedAssociated(ctx context.Context, schema []byte, in seedInput, rowID string, orgID int64, assoc associationRequest) (row []byte, associationID, model string, err error) {
	body, err := json.Marshal(struct {
		seedInput
		RowID            string `json:"rowId"`
		OrgID            int64  `json:"orgId"`
		SupplierSourceID string `json:"supplierSourceId"`
		VariantGroup     string `json:"variantGroup"`
	}{in, rowID, orgID, assoc.SupplierSourceID, assoc.VariantGroup})
	if err != nil {
		return nil, "", "", err
	}
	out, err := h.core().Call(ctx, OpSeedAssociatedRow, schema, body)
	if err != nil {
		status, message, code := refuseCore(err)
		return nil, "", "", rowRefuse{status, message, code}
	}
	var answer struct {
		Row           json.RawMessage `json:"row"`
		AssociationID string          `json:"associationId"`
		ModelValue    string          `json:"modelValue"`
	}
	if err := json.Unmarshal(out, &answer); err != nil || len(answer.Row) == 0 || answer.AssociationID == "" || answer.ModelValue == "" {
		return nil, "", "", coreUnreadable("OpSeedAssociatedRow", err)
	}
	return answer.Row, answer.AssociationID, answer.ModelValue, nil
}

type rowRefuse struct {
	status  int
	message string
	code    string
}

func (e rowRefuse) Error() string { return e.message }

func (h Host) clock() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}

func (h Host) schemaFor(r *http.Request, tx pgx.Tx, payload []byte) (schema []byte, revision string, err error) {
	cat, typ, lang, ok := categoryOf(payload)
	if !ok {
		return nil, "", rowRefuse{http.StatusBadRequest, "上架方案载荷不是可用的方案文档：missing field `descriptionCategoryId`", "validation"}
	}
	if lang == "" {
		lang = "default"
	}
	var fields json.RawMessage
	var fetched int64
	err = tx.QueryRow(r.Context(), `
		SELECT fields, fetched_at_ms, COALESCE(schema_revision, '') FROM public.ozon_category_current
		WHERE description_category_id = $1 AND type_id = $2 AND language = $3`, cat, typ, lang).Scan(&fields, &fetched, &revision)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && h.clock().UnixMilli()-fetched > schemaTTLMS) {
		return nil, "", rowRefuse{http.StatusConflict, "该类目尚未同步，请先同步类目字段后重试", "schema_sync_required"}
	}
	if err != nil {
		return nil, "", err
	}
	input, err := json.Marshal(struct {
		Category int64           `json:"description_category_id"`
		TypeID   int64           `json:"type_id"`
		Fields   json.RawMessage `json:"fields"`
	}{cat, typ, fields})
	if err != nil {
		return nil, "", err
	}
	if h.core() == nil {
		return nil, "", errors.New("listing-core wasm is not loaded")
	}
	computed, err := h.core().Snapshot(r.Context(), input)
	if err != nil {
		status, message, code := refuseCore(err)
		return nil, "", rowRefuse{status, message, code}
	}
	var rev struct {
		Revision string `json:"schema_revision"`
	}
	if err := json.Unmarshal(computed, &rev); err != nil || rev.Revision == "" {
		return nil, "", errors.New("schema revision")
	}
	if revision != "" && revision != rev.Revision {
		return nil, "", rowRefuse{http.StatusConflict, "类目字段版本已变化，请重新同步类目后重试", "schema_sync_required"}
	}
	revision = rev.Revision
	var snapshot []byte
	err = tx.QueryRow(r.Context(), `
		SELECT snapshot FROM public.listing_schema_revisions WHERE schema_revision = $1`, revision).Scan(&snapshot)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", rowRefuse{http.StatusConflict, "类目字段版本尚未注册，请重新同步类目后重试", "schema_sync_required"}
	}
	if err != nil {
		return nil, "", err
	}
	if !catalogcontract.SameSnapshot(snapshot, computed) {
		return nil, "", rowRefuse{http.StatusConflict, "类目字段版本内容不一致，已拒绝保存", "conflict"}
	}
	var search json.RawMessage
	err = tx.QueryRow(r.Context(), `
		SELECT COALESCE(jsonb_agg(jsonb_build_object(
		  'descriptionCategoryId',description_category_id,'attributeId',attribute_id,
		  'dictionaryId',dictionary_id,'valueId',option_id,'label',value)
		  ORDER BY attribute_id,dictionary_id,option_id),'[]'::jsonb)
		FROM public.catalog_dictionary_search_material
		WHERE description_category_id=$1 AND type_id=$2 AND language=$3`, cat, typ, lang).Scan(&search)
	if err != nil {
		return nil, "", err
	}
	schema, err = json.Marshal(map[string]json.RawMessage{
		"snapshot": json.RawMessage(snapshot), "searchMaterials": search,
	})
	return schema, revision, err
}

// supplierBinding proves the claimed design is the one the Card was created
// from. A Card with no supplier product has nothing to prove it against, so
// it cannot join an association.
func supplierBinding(r *http.Request, tx pgx.Tx, payload []byte, req associationRequest) string {
	const refused = "该上架方案的货源绑定与本次同款来源不一致，服务端拒绝关联；请从货源清单重新导入"
	var card map[string]any
	if err := json.Unmarshal(payload, &card); err != nil {
		return refused
	}
	product, _ := card["supplierProductId"].(string)
	product = strings.TrimSpace(product)
	if product == "" {
		return refused
	}
	var source, group string
	err := tx.QueryRow(r.Context(), `
		SELECT p.source_id, p.variant_group FROM public.sc_products p
		WHERE p.product_id = $1 AND p.archived = false`, product).Scan(&source, &group)
	if err != nil || strings.TrimSpace(source) != strings.TrimSpace(req.SupplierSourceID) || strings.TrimSpace(group) != strings.TrimSpace(req.VariantGroup) {
		return refused
	}
	return ""
}

func hasAssociation(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null"))
}

func hex64(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	trimmed = strings.TrimPrefix(trimmed, "sha256:")
	if len(trimmed) != 64 {
		return "", false
	}
	for _, r := range trimmed {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
			return "", false
		}
	}
	return strings.ToLower(trimmed), true
}

func canonicalDraft(raw json.RawMessage) (string, json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", nil, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return "", nil, err
	}
	values := obj["values"]
	if len(values) == 0 {
		values = json.RawMessage(`{}`)
	}
	var valueMap map[string]json.RawMessage
	if err := json.Unmarshal(values, &valueMap); err != nil {
		return "", nil, errors.New("invalid type: map, expected a map for values")
	}
	if !normalizeMediaDraftValues(valueMap) {
		return "", nil, errors.New("图片字段必须使用字符串或字符串列表")
	}
	sorted, err := json.Marshal(valueMap)
	if err != nil {
		return "", nil, err
	}
	complex := obj["complex_values"]
	if len(complex) == 0 {
		complex = json.RawMessage(`[]`)
	}
	if !bytes.HasPrefix(bytes.TrimSpace(complex), []byte("[")) {
		return "", nil, errors.New("invalid type: expected a sequence for complex_values")
	}
	out := map[string]json.RawMessage{"values": sorted, "complex_values": complex}
	if cleared := obj["cleared"]; len(bytes.TrimSpace(cleared)) > 0 && string(bytes.TrimSpace(cleared)) != "null" && string(bytes.TrimSpace(cleared)) != "[]" {
		out["cleared"] = cleared
	}
	encoded, err := marshalDraft(out)
	if err != nil {
		return "", nil, err
	}
	return string(encoded), encoded, nil
}

// Match Go's canonical object semantics before Rust decodes the media tags.
func normalizeMediaDraftValues(values map[string]json.RawMessage) bool {
	for _, key := range []string{"images", "images360", "primary_image", "color_image"} {
		raw, ok := values[key]
		if !ok {
			continue
		}
		var value map[string]json.RawMessage
		if json.Unmarshal(raw, &value) != nil || jsonNull(value["value"]) {
			return false
		}
		var kind string
		if json.Unmarshal(value["kind"], &kind) != nil {
			return false
		}
		switch kind {
		case "text", "url":
			var text string
			if json.Unmarshal(value["value"], &text) != nil {
				return false
			}
		case "text_list", "url_list":
			var list []json.RawMessage
			if json.Unmarshal(value["value"], &list) != nil {
				return false
			}
			for _, item := range list {
				var text string
				if jsonNull(item) || json.Unmarshal(item, &text) != nil {
					return false
				}
			}
		default:
			return false
		}
		encoded, err := json.Marshal(map[string]json.RawMessage{"kind": value["kind"], "value": value["value"]})
		if err != nil {
			return false
		}
		values[key] = encoded
	}
	return true
}

func marshalDraft(fields map[string]json.RawMessage) ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	buf.WriteString(`"values":`)
	buf.Write(fields["values"])
	buf.WriteString(`,"complex_values":`)
	buf.Write(fields["complex_values"])
	if cleared, ok := fields["cleared"]; ok {
		buf.WriteString(`,"cleared":`)
		buf.Write(cleared)
	}
	buf.WriteByte('}')
	if !json.Valid(buf.Bytes()) {
		return nil, errors.New("draft")
	}
	return buf.Bytes(), nil
}

func (h Host) finishPatchRow(w http.ResponseWriter, r *http.Request, p access.Principal, id string, base int64, fields map[string]json.RawMessage, rowPayload, cardPayload []byte) {
	_, draftSent := fields["draft"]
	_, changesSent := fields["changes"]
	_, payloadSent := fields["payload"]
	_, storeSent := fields["storeId"]
	clear := false
	if raw, ok := fields["clearGeneratedContent"]; ok && string(raw) == "true" {
		clear = true
	}
	decisions := false
	if raw, ok := fields["candidateDecisions"]; ok && string(raw) != "null" {
		decisions = true
	}
	fill := flagTrue(fields, "fillBlank")
	if decisions {
		if draftSent || changesSent || payloadSent || storeSent || clear || fill {
			writeErr(w, http.StatusBadRequest, "候选确认不能与其他字段写入一起提交", "validation")
			return
		}
		h.decideCandidates(w, r, p, id, base, fields["candidateDecisions"], rowPayload, cardPayload)
		return
	}
	if clear {
		if draftSent || changesSent || payloadSent || storeSent || fill {
			writeErr(w, http.StatusBadRequest, "清空生成内容不能与其他字段写入一起提交", "validation")
			return
		}
		h.clearGenerated(w, r, p, id, base, rowPayload, cardPayload)
		return
	}
	if !draftSent && !changesSent && !payloadSent && !storeSent {
		writeErr(w, http.StatusBadRequest, "changes、payload、draft 或 storeId 必填", "validation")
		return
	}
	if draftSent {
		if !leanRow(rowPayload) {
			writeErr(w, http.StatusBadRequest, "商品行载荷不是可校验的上架文档：missing field `categoryKey`", "validation")
			return
		}
		h.editDraft(w, r, p, id, base, fields, rowPayload, cardPayload)
		return
	}
	if storeSent && !changesSent && !payloadSent {
		h.rebindRow(w, r, p, id, base, fields["storeId"])
		return
	}
	h.mergeRowFields(w, r, p, id, base, fields, rowPayload)
}

func leanRow(payload []byte) bool {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(payload, &body); err != nil {
		return false
	}
	for _, key := range []string{"categoryKey", "descriptionCategoryId", "typeId", "schemaRevision", "draft"} {
		if _, ok := body[key]; !ok {
			return false
		}
	}
	return true
}

func (h Host) rebindRow(w http.ResponseWriter, r *http.Request, p access.Principal, id string, base int64, raw json.RawMessage) {
	store := ""
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
		store = bound
	}
	var item storedScan
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE listing_rows
			SET store_id = NULLIF($4, '')::uuid,
			    revision = revision + 1,
			    updated_by = NULLIF($5, 0),
			    updated_at = clock_timestamp()
			WHERE org_id = $1 AND id = $2::uuid AND revision = $3`, p.OrgID, id, base, store, p.UserID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return rowRefuse{http.StatusConflict, "商品行已被他人更新，请刷新后重试", "conflict"}
		}
		item, err = scanStoredRow(tx.QueryRow(r.Context(), `SELECT `+rowColumns+` FROM listing_rows WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, id))
		return err
	})
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

func (h Host) editDraft(w http.ResponseWriter, r *http.Request, p access.Principal, id string, base int64, fields map[string]json.RawMessage, rowPayload, cardPayload []byte) {
	draft, _, err := canonicalDraft(fields["draft"])
	if err != nil {
		writeErr(w, http.StatusBadRequest, "draft 不是有效的上架草稿："+err.Error(), "validation")
		return
	}
	light := false
	if raw, ok := fields["mode"]; ok && string(raw) != "null" {
		var text string
		_ = json.Unmarshal(raw, &text)
		light = text == "light"
	}
	storeMoved := false
	store := ""
	storeSet := false
	if raw, ok := fields["storeId"]; ok {
		storeSet = true
		storeMoved = true
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
			store = bound
		}
	}
	changes := json.RawMessage(`{}`)
	if raw, ok := fields["changes"]; ok && string(raw) != "null" {
		changes = raw
	}
	if h.core() == nil {
		writeErr(w, http.StatusInternalServerError, "服务暂不可用", "internal")
		return
	}
	var item storedScan
	err = h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		schema, revision, err := h.schemaFor(r, tx, cardPayload)
		if err != nil {
			return err
		}
		body, err := json.Marshal(map[string]any{
			"card": json.RawMessage(cardPayload), "nowMs": h.clock().UnixMilli(),
			"row": json.RawMessage(rowPayload),
			"edit": map[string]any{
				"kind": "draft", "changes": json.RawMessage(changes), "draft": json.RawMessage(draft),
				"light": light, "storeMoved": storeMoved,
			},
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
		state := factState(edited.Fact)
		tag, err := tx.Exec(r.Context(), `
			UPDATE listing_rows
			SET payload = $4::jsonb,
			    validation_state = $5,
			    schema_revision = COALESCE(NULLIF($6, ''), schema_revision),
			    content_state = COALESCE(NULLIF($7, ''), content_state),
			    media_state = COALESCE(NULLIF($8, ''), media_state),
			    submission_state = COALESCE(NULLIF($9, ''), submission_state),
			    store_id = CASE WHEN $10 THEN NULLIF($11, '')::uuid ELSE store_id END,
			    revision = revision + 1,
			    updated_by = NULLIF($12, 0),
			    updated_at = clock_timestamp()
			WHERE org_id = $1 AND id = $2::uuid AND revision = $3`,
			p.OrgID, id, base, string(edited.Row), state, revision,
			textOrEmpty(edited.Invalidation.Content), textOrEmpty(edited.Invalidation.Media), textOrEmpty(edited.Invalidation.Submission),
			storeSet, store, p.UserID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return rowRefuse{http.StatusConflict, "商品行已被他人更新，请刷新后重试", "conflict"}
		}
		item, err = scanStoredRow(tx.QueryRow(r.Context(), `SELECT `+rowColumns+` FROM listing_rows WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, id))
		return err
	})
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

func textOrEmpty(v *string) string {
	if v == nil {
		return ""
	}
	switch *v {
	case "draft", "recognizing", "ready", "failed", "pending", "processing", "none", "queued", "submitting", "unknown", "accepted", "rejected":
		return *v
	default:
		return ""
	}
}
