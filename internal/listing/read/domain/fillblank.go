package domain

import (
	"bytes"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

// PayloadDecodePrefix is the pinned Rust prefix. The serde Display tail is not pinned.
const PayloadDecodePrefix = "listing row payload decode: "

const sourceReviewIssue = "源图已更换，旧值没有来源记录；请保留现值、手工修改或重新识别后采用新值"

// Trigger is one invalidation edge, in Rust Ord order.
type Trigger int

const (
	TriggerPrompt Trigger = iota
	TriggerCategory
	TriggerPsd
	TriggerSource
	TriggerVideo
	TriggerManual
	TriggerStore
)

// TriggersForChanges scans top-level key names. A non-object yields nothing.
// fillBlank true never adds ManualField.
func TriggersForChanges(changes json.RawMessage, fillBlank bool) []Trigger {
	var obj map[string]json.RawMessage
	if json.Unmarshal(changes, &obj) != nil || obj == nil {
		return nil
	}
	var out []Trigger
	for key := range obj {
		switch key {
		case "prompt", "recognitionPrompt", "aiPrompt":
			out = append(out, TriggerPrompt)
		case "descriptionCategoryId", "typeId", "categoryKey", "description_category_id", "type_id":
			out = append(out, TriggerCategory)
		case "psdAssetId", "psdRevision", "psdBinding", "psd_asset_id":
			out = append(out, TriggerPsd)
		case "source", "sourceSha256", "sourceAssetId":
			out = append(out, TriggerSource)
		case "videoAssetId", "videoBinding", "videoUrl", "video_asset_id":
			out = append(out, TriggerVideo)
		case "storeId", "store_id":
			out = append(out, TriggerStore)
		}
	}
	if !fillBlank && len(obj) > 0 {
		out = append(out, TriggerManual)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	dedup := out[:0]
	for _, t := range out {
		if len(dedup) == 0 || dedup[len(dedup)-1] != t {
			dedup = append(dedup, t)
		}
	}
	return dedup
}

// HasTrigger reports whether the sorted list contains t.
func HasTrigger(list []Trigger, t Trigger) bool {
	for _, item := range list {
		if item == t {
			return true
		}
	}
	return false
}

// WithoutTrigger returns a copy that drops t.
func WithoutTrigger(list []Trigger, t Trigger) []Trigger {
	out := make([]Trigger, 0, len(list))
	for _, item := range list {
		if item != t {
			out = append(out, item)
		}
	}
	return out
}

// ColumnOverlay is one trigger's content, media, and submission reset.
// A nil pointer keeps the stored column. Validation is always stale.
type ColumnOverlay struct {
	Content    *string
	Media      *string
	Submission *string
}

// OverlayOf is the row-lifecycle column reset for one trigger.
func OverlayOf(t Trigger) ColumnOverlay {
	draft, pending, none := "draft", "pending", "none"
	switch t {
	case TriggerPrompt:
		return ColumnOverlay{Content: &draft, Submission: &none}
	case TriggerCategory, TriggerStore:
		return ColumnOverlay{Content: &draft, Media: &pending, Submission: &none}
	case TriggerSource:
		return ColumnOverlay{Content: &draft, Media: &pending}
	case TriggerPsd, TriggerVideo:
		return ColumnOverlay{Media: &pending}
	default:
		return ColumnOverlay{}
	}
}

// StripSchemaReference deletes top-level schemaSnapshot and schemaRevision.
// A non-object is returned unchanged.
func StripSchemaReference(raw json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return append(json.RawMessage(nil), raw...)
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil || obj == nil {
		return append(json.RawMessage(nil), raw...)
	}
	delete(obj, "schemaSnapshot")
	delete(obj, "schemaRevision")
	out, err := json.Marshal(obj)
	if err != nil {
		return append(json.RawMessage(nil), raw...)
	}
	return out
}

// SourceChanged compares /source/sha256. A missing path is not equal to JSON null.
func SourceChanged(previous, next json.RawMessage) bool {
	left, lok := jsonPointer(previous, "source", "sha256")
	right, rok := jsonPointer(next, "source", "sha256")
	if lok != rok {
		return true
	}
	if !lok {
		return false
	}
	return !rawEqual(left, right)
}

// HadSource is true when /source/sha256 is a non-empty string.
func HadSource(previous json.RawMessage) bool {
	raw, ok := jsonPointer(previous, "source", "sha256")
	if !ok {
		return false
	}
	var text string
	if json.Unmarshal(raw, &text) != nil {
		return false
	}
	return text != ""
}

func jsonPointer(doc json.RawMessage, path ...string) (json.RawMessage, bool) {
	cur := bytes.TrimSpace(doc)
	for _, key := range path {
		if len(cur) == 0 || string(cur) == "null" || cur[0] != '{' {
			return nil, false
		}
		var obj map[string]json.RawMessage
		if json.Unmarshal(cur, &obj) != nil || obj == nil {
			return nil, false
		}
		next, ok := obj[key]
		if !ok {
			return nil, false
		}
		cur = bytes.TrimSpace(next)
	}
	return json.RawMessage(cur), true
}

func rawEqual(a, b json.RawMessage) bool {
	var left, right any
	if json.Unmarshal(a, &left) != nil || json.Unmarshal(b, &right) != nil {
		return bytes.Equal(bytes.TrimSpace(a), bytes.TrimSpace(b))
	}
	lb, err1 := json.Marshal(left)
	rb, err2 := json.Marshal(right)
	return err1 == nil && err2 == nil && bytes.Equal(lb, rb)
}

// ProtectContentSections is patch.rs protect_content_sections.
// payloadSome and draftSome follow Option::is_some (JSON null is not some).
func ProtectContentSections(stored, changes json.RawMessage, payloadSome, draftSome bool) string {
	storedObj := object(stored)
	changeObj := object(changes)
	for _, key := range []string{"ai", "fieldOrigins", "handEditedKeys", "supplierProductId"} {
		_, inChanges := changeObj[key]
		if (inChanges || (payloadSome && !draftSome)) && !optionEqual(changeObj, storedObj, key) {
			return "识别证据与字段来源由服务端维护，请使用候选确认或草稿编辑"
		}
	}
	if !draftSome {
		if draft, ok := changeObj["draft"]; ok {
			storedDraft, storedOK := storedObj["draft"]
			if !storedOK || !rawEqual(draft, storedDraft) {
				return "草稿值请通过 draft 编辑字段提交"
			}
		}
	}
	return ""
}

func optionEqual(changes, stored map[string]json.RawMessage, key string) bool {
	cv, cok := changes[key]
	sv, sok := stored[key]
	if cok != sok {
		return false
	}
	if !cok {
		return true
	}
	return rawEqual(cv, sv)
}

func object(raw json.RawMessage) map[string]json.RawMessage {
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil || obj == nil {
		return map[string]json.RawMessage{}
	}
	return obj
}

// AuthoringMediaChanges rejects client media receipts and copies stored media
// back when the patch carries media or a payload. The returned document is
// the protected client_changes.
func AuthoringMediaChanges(stored, changes json.RawMessage, payloadSome bool) (json.RawMessage, string) {
	changeObj := object(changes)
	storedObj := object(stored)
	if raw, ok := changeObj["renderEvidence"]; ok {
		sv, sok := storedObj["renderEvidence"]
		if !sok || !rawEqual(raw, sv) {
			return nil, "切片清单和图片回执只能由媒体作业写入"
		}
	}
	_, mediaKey := changeObj["media"]
	if mediaKey {
		media := bytes.TrimSpace(changeObj["media"])
		if len(media) == 0 || media[0] != '{' {
			return nil, "切片清单和图片回执只能由媒体作业写入"
		}
		var sent map[string]json.RawMessage
		if json.Unmarshal(media, &sent) != nil || sent == nil {
			return nil, "切片清单和图片回执只能由媒体作业写入"
		}
		if !optionEqual(sent, mediaObject(storedObj["media"]), "images") {
			return nil, "切片清单和图片回执只能由媒体作业写入"
		}
	}
	if !mediaKey && !payloadSome {
		return append(json.RawMessage(nil), changes...), ""
	}
	base := map[string]json.RawMessage{}
	if storedMedia := bytes.TrimSpace(storedObj["media"]); len(storedMedia) > 0 && storedMedia[0] == '{' {
		_ = json.Unmarshal(storedMedia, &base)
		if base == nil {
			base = map[string]json.RawMessage{}
		}
	}
	if mediaKey {
		var overlay map[string]json.RawMessage
		_ = json.Unmarshal(changeObj["media"], &overlay)
		for k, v := range overlay {
			base[k] = v
		}
	}
	merged, err := json.Marshal(base)
	if err != nil {
		return nil, "切片清单和图片回执只能由媒体作业写入"
	}
	changeObj["media"] = merged
	if payloadSome {
		if ev, ok := storedObj["renderEvidence"]; ok {
			changeObj["renderEvidence"] = ev
		} else {
			delete(changeObj, "renderEvidence")
		}
	}
	out, err := json.Marshal(changeObj)
	if err != nil {
		return nil, "切片清单和图片回执只能由媒体作业写入"
	}
	return out, ""
}

func mediaObject(raw json.RawMessage) map[string]json.RawMessage {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' {
		return map[string]json.RawMessage{}
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil || obj == nil {
		return map[string]json.RawMessage{}
	}
	return obj
}

// InvalidateSourceContent decodes a row payload, retires AI-owned values, and
// returns {"draft","ai","fieldOrigins"} for payload || patch.
func InvalidateSourceContent(payload, previous json.RawMessage) (json.RawMessage, error) {
	doc, err := decodeRow(payload)
	if err != nil {
		return nil, err
	}
	had := HadSource(previous)
	schema := doc.schema
	kept := doc.origins[:0]
	for _, origin := range doc.origins {
		if origin.Kind == "ai_confirmed" && !doc.manual(origin.Address) {
			doc.clearValue(origin.Address)
			continue
		}
		kept = append(kept, origin)
	}
	doc.origins = kept
	doc.ai = defaultAI()
	if had {
		doc.appendReviews(schema)
	}
	draft, err := doc.marshalDraft()
	if err != nil {
		return nil, err
	}
	ai, err := json.Marshal(doc.ai)
	if err != nil {
		return nil, err
	}
	origins, err := doc.marshalOrigins()
	if err != nil {
		return nil, err
	}
	return json.Marshal(struct {
		Draft   json.RawMessage `json:"draft"`
		AI      json.RawMessage `json:"ai"`
		Origins json.RawMessage `json:"fieldOrigins"`
	}{draft, ai, origins})
}

type rowDoc struct {
	draft      draftDoc
	origins    []originDoc
	hand       map[string]bool
	ai         aiDoc
	schema     []schemaField
	complexRaw json.RawMessage
}

type draftDoc struct {
	values  map[string]json.RawMessage
	complex []complexGroup
	cleared []string
}

type complexGroup struct {
	ID    int64         `json:"complex_id"`
	Items []complexItem `json:"items"`
}

type complexItem struct {
	ItemID string                     `json:"item_id,omitempty"`
	Values map[string]json.RawMessage `json:"values"`
}

type originDoc struct {
	Address   fieldAddr `json:"address"`
	Kind      string    `json:"kind"`
	SourceRef *string   `json:"source_ref"`
	UpdatedAt uint64    `json:"updated_at_ms"`
	rawAddr   json.RawMessage
}

type fieldAddr struct {
	Kind       string  `json:"kind"`
	FieldKey   string  `json:"field_key"`
	GroupKey   string  `json:"group_key"`
	ItemID     string  `json:"item_id"`
	ValueIndex *uint32 `json:"value_index"`
}

func (a fieldAddr) same(b fieldAddr) bool {
	if a.Kind != b.Kind || a.FieldKey != b.FieldKey {
		return false
	}
	if a.Kind != "complex" {
		return true
	}
	if a.GroupKey != b.GroupKey || a.ItemID != b.ItemID {
		return false
	}
	if (a.ValueIndex == nil) != (b.ValueIndex == nil) {
		return false
	}
	return a.ValueIndex == nil || *a.ValueIndex == *b.ValueIndex
}

type schemaField struct {
	Key         string
	ReadOnly    bool
	AttributeID *int64
	ComplexID   *string
}

type aiDoc struct {
	RequestID  string      `json:"requestId"`
	Candidates []candidate `json:"candidates"`
	PromptSHA  string      `json:"promptSha256"`
	Model      string      `json:"modelVersion"`
}

type candidate struct {
	Address plainOrComplex  `json:"address"`
	Value   json.RawMessage `json:"value"`
	Current json.RawMessage `json:"current_value"`
	Source  string          `json:"source"`
	State   string          `json:"state"`
	Issue   *string         `json:"issue"`
}

type plainOrComplex struct {
	raw fieldAddr
}

func (p plainOrComplex) MarshalJSON() ([]byte, error) {
	if p.raw.Kind == "complex" {
		body := struct {
			Kind       string  `json:"kind"`
			GroupKey   string  `json:"group_key"`
			ItemID     string  `json:"item_id"`
			FieldKey   string  `json:"field_key"`
			ValueIndex *uint32 `json:"value_index"`
		}{"complex", p.raw.GroupKey, p.raw.ItemID, p.raw.FieldKey, p.raw.ValueIndex}
		return json.Marshal(body)
	}
	return json.Marshal(struct {
		Kind     string `json:"kind"`
		FieldKey string `json:"field_key"`
	}{"plain", p.raw.FieldKey})
}

func defaultAI() aiDoc {
	return aiDoc{Candidates: []candidate{}}
}

func (d *rowDoc) manual(addr fieldAddr) bool {
	if addr.Kind == "plain" && d.hand[addr.FieldKey] {
		return true
	}
	for _, origin := range d.origins {
		if origin.Kind == "manual" && origin.Address.same(addr) {
			return true
		}
	}
	return false
}

func (d *rowDoc) clearValue(addr fieldAddr) {
	if addr.Kind == "plain" {
		delete(d.draft.values, addr.FieldKey)
		return
	}
	groupID, err := strconv.ParseInt(addr.GroupKey, 10, 64)
	if err != nil || addr.ValueIndex != nil || !stableItem(addr.ItemID) {
		return
	}
	for i := range d.draft.complex {
		if d.draft.complex[i].ID != groupID {
			continue
		}
		for j := range d.draft.complex[i].Items {
			if d.draft.complex[i].Items[j].ItemID == addr.ItemID {
				delete(d.draft.complex[i].Items[j].Values, addr.FieldKey)
			}
		}
	}
}

func (d *rowDoc) appendReviews(schema []schemaField) {
	allowed, protected := aiPolicy(schema)
	for _, addr := range d.addresses() {
		if !aiAllowed(schema, allowed, protected, addr) || d.manual(addr) || d.hasOrigin(addr) {
			continue
		}
		raw, ok := d.valueAt(addr)
		if !ok || !hasContent(raw) {
			continue
		}
		issue := sourceReviewIssue
		d.ai.Candidates = append(d.ai.Candidates, candidate{
			Address: plainOrComplex{addr},
			Value:   append(json.RawMessage(nil), raw...),
			Current: append(json.RawMessage(nil), raw...),
			Source:  "source_changed",
			State:   "unresolved",
			Issue:   &issue,
		})
	}
}

func (d *rowDoc) hasOrigin(addr fieldAddr) bool {
	for _, origin := range d.origins {
		if origin.Address.same(addr) {
			return true
		}
	}
	return false
}

func (d *rowDoc) valueAt(addr fieldAddr) (json.RawMessage, bool) {
	if addr.Kind == "plain" {
		raw, ok := d.draft.values[addr.FieldKey]
		return raw, ok
	}
	groupID, err := strconv.ParseInt(addr.GroupKey, 10, 64)
	if err != nil {
		return nil, false
	}
	for _, group := range d.draft.complex {
		if group.ID != groupID {
			continue
		}
		for _, item := range group.Items {
			if item.ItemID == addr.ItemID {
				raw, ok := item.Values[addr.FieldKey]
				return raw, ok
			}
		}
	}
	return nil, false
}

func (d *rowDoc) addresses() []fieldAddr {
	keys := make([]string, 0, len(d.draft.values))
	for key := range d.draft.values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]fieldAddr, 0, len(keys))
	for _, key := range keys {
		out = append(out, fieldAddr{Kind: "plain", FieldKey: key})
	}
	for _, group := range d.draft.complex {
		for _, item := range group.Items {
			if !stableItem(item.ItemID) {
				continue
			}
			ikeys := make([]string, 0, len(item.Values))
			for key := range item.Values {
				ikeys = append(ikeys, key)
			}
			sort.Strings(ikeys)
			for _, key := range ikeys {
				out = append(out, fieldAddr{
					Kind: "complex", GroupKey: strconv.FormatInt(group.ID, 10),
					ItemID: item.ItemID, FieldKey: key,
				})
			}
		}
	}
	return out
}

func (d *rowDoc) marshalDraft() (json.RawMessage, error) {
	values := d.draft.values
	if values == nil {
		values = map[string]json.RawMessage{}
	}
	complexRaw := json.RawMessage(`[]`)
	if len(d.draft.complex) > 0 {
		encoded, err := json.Marshal(d.draft.complex)
		if err != nil {
			return nil, err
		}
		complexRaw = encoded
	}
	body := struct {
		Values  map[string]json.RawMessage `json:"values"`
		Complex json.RawMessage            `json:"complex_values"`
		Cleared []string                   `json:"cleared,omitempty"`
	}{Values: values, Complex: complexRaw}
	if len(d.draft.cleared) > 0 {
		cleared := append([]string(nil), d.draft.cleared...)
		sort.Strings(cleared)
		body.Cleared = cleared
	}
	return json.Marshal(body)
}

func (d *rowDoc) marshalOrigins() (json.RawMessage, error) {
	if len(d.origins) == 0 {
		return json.RawMessage(`[]`), nil
	}
	out := make([]originOut, len(d.origins))
	for i, origin := range d.origins {
		addr := origin.rawAddr
		if len(bytes.TrimSpace(addr)) == 0 {
			encoded, err := json.Marshal(plainOrComplex{origin.Address})
			if err != nil {
				return nil, err
			}
			addr = encoded
		}
		out[i] = originOut{Address: addr, Kind: origin.Kind, SourceRef: origin.SourceRef, UpdatedAt: origin.UpdatedAt}
	}
	return json.Marshal(out)
}

type originOut struct {
	Address   json.RawMessage `json:"address"`
	Kind      string          `json:"kind"`
	SourceRef *string         `json:"source_ref"`
	UpdatedAt uint64          `json:"updated_at_ms"`
}

func aiPolicy(fields []schemaField) (allowed, protected map[string]bool) {
	protected = map[string]bool{}
	allowed = map[string]bool{}
	for _, field := range fields {
		if protectedField(field) {
			protected[field.Key] = true
		} else if !field.ReadOnly {
			allowed[field.Key] = true
		}
	}
	return allowed, protected
}

func aiAllowed(fields []schemaField, allowed, protected map[string]bool, addr fieldAddr) bool {
	if !allowed[addr.FieldKey] || protected[addr.FieldKey] {
		return false
	}
	for _, field := range fields {
		if field.Key != addr.FieldKey || field.ReadOnly || protectedField(field) {
			continue
		}
		if addr.Kind == "plain" {
			return field.ComplexID == nil
		}
		return field.ComplexID != nil && *field.ComplexID == addr.GroupKey
	}
	return false
}

func protectedField(field schemaField) bool {
	switch field.Key {
	case "price", "old_price", "depth", "width", "height", "dimension", "weight",
		"offer_id", "images", "images360", "primary_image", "color_image":
		return true
	}
	if field.AttributeID == nil {
		return false
	}
	switch *field.AttributeID {
	case 85, 9024, 9048:
		return true
	default:
		return false
	}
}

func hasContent(raw json.RawMessage) bool {
	var body struct {
		Kind  string          `json:"kind"`
		Value json.RawMessage `json:"value"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return false
	}
	switch body.Kind {
	case "text", "url":
		var text string
		if json.Unmarshal(body.Value, &text) != nil {
			return false
		}
		return strings.TrimSpace(text) != ""
	case "text_list", "url_list":
		var list []string
		if json.Unmarshal(body.Value, &list) != nil {
			return false
		}
		for _, text := range list {
			if strings.TrimSpace(text) != "" {
				return true
			}
		}
		return false
	case "integer_list", "decimal_list", "boolean_list", "multi_select":
		var list []json.RawMessage
		if json.Unmarshal(body.Value, &list) != nil {
			return false
		}
		return len(list) > 0
	case "single_select":
		var sel struct {
			ID    int64  `json:"dictionary_value_id"`
			Value string `json:"value"`
		}
		if json.Unmarshal(body.Value, &sel) != nil {
			return false
		}
		return sel.ID != 0 || strings.TrimSpace(sel.Value) != ""
	case "integer", "decimal", "boolean":
		return true
	default:
		return false
	}
}

func stableItem(id string) bool {
	if id == "" || legacyItem(id) {
		return false
	}
	return true
}

func legacyItem(id string) bool {
	if rest, ok := strings.CutPrefix(id, "item_"); ok && rest != "" && digits(rest) {
		return true
	}
	rest, ok := strings.CutPrefix(id, "workflow-")
	if !ok {
		return false
	}
	idx := strings.LastIndex(rest, "-")
	if idx <= 0 || idx == len(rest)-1 {
		return false
	}
	return digits(rest[idx+1:])
}

func digits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func decodeRow(payload json.RawMessage) (rowDoc, error) {
	var top map[string]json.RawMessage
	if json.Unmarshal(payload, &top) != nil || top == nil {
		return rowDoc{}, decodeErr("invalid payload")
	}
	for _, key := range []string{"categoryKey", "descriptionCategoryId", "typeId", "schemaRevision", "schemaSnapshot"} {
		if _, ok := top[key]; !ok {
			return rowDoc{}, decodeErr("missing field `" + key + "`")
		}
	}
	var snap map[string]json.RawMessage
	if json.Unmarshal(top["schemaSnapshot"], &snap) != nil || snap == nil {
		return rowDoc{}, decodeErr("invalid schemaSnapshot")
	}
	for _, key := range []string{"category_key", "label", "description_category_id", "type_id", "schema_revision", "recipe_id", "recipe_revision", "catalog_schema_version", "fields"} {
		if _, ok := snap[key]; !ok {
			return rowDoc{}, decodeErr("missing field `" + key + "`")
		}
	}
	var fields []map[string]json.RawMessage
	if json.Unmarshal(snap["fields"], &fields) != nil {
		return rowDoc{}, decodeErr("invalid fields")
	}
	schema := make([]schemaField, 0, len(fields))
	for _, field := range fields {
		for _, key := range []string{"key", "label", "group", "editor", "required", "attribute_id"} {
			if _, ok := field[key]; !ok {
				return rowDoc{}, decodeErr("missing field `" + key + "`")
			}
		}
		var key string
		if json.Unmarshal(field["key"], &key) != nil {
			return rowDoc{}, decodeErr("invalid field key")
		}
		item := schemaField{Key: key}
		if raw, ok := field["read_only"]; ok && string(bytes.TrimSpace(raw)) != "null" {
			if json.Unmarshal(raw, &item.ReadOnly) != nil {
				return rowDoc{}, decodeErr("invalid read_only")
			}
		}
		if raw := bytes.TrimSpace(field["attribute_id"]); string(raw) != "null" {
			var text string
			if json.Unmarshal(raw, &text) != nil {
				return rowDoc{}, decodeErr("invalid attribute_id")
			}
			if text != "" {
				n, err := strconv.ParseInt(text, 10, 64)
				if err == nil {
					item.AttributeID = &n
				}
			}
		}
		if raw, ok := field["complex_id"]; ok && string(bytes.TrimSpace(raw)) != "null" {
			var text string
			if json.Unmarshal(raw, &text) != nil {
				return rowDoc{}, decodeErr("invalid complex_id")
			}
			if text != "" {
				item.ComplexID = &text
			}
		}
		schema = append(schema, item)
	}
	doc := rowDoc{schema: schema, hand: map[string]bool{}, ai: defaultAI()}
	if raw, ok := top["draft"]; ok && string(bytes.TrimSpace(raw)) != "null" {
		parsed, err := decodeDraft(raw)
		if err != nil {
			return rowDoc{}, err
		}
		doc.draft = parsed
	} else {
		doc.draft.values = map[string]json.RawMessage{}
	}
	if raw, ok := top["handEditedKeys"]; ok && string(bytes.TrimSpace(raw)) != "null" {
		var keys []string
		if json.Unmarshal(raw, &keys) != nil {
			return rowDoc{}, decodeErr("invalid handEditedKeys")
		}
		for _, key := range keys {
			doc.hand[key] = true
		}
	}
	if raw, ok := top["fieldOrigins"]; ok && string(bytes.TrimSpace(raw)) != "null" {
		var rows []json.RawMessage
		if json.Unmarshal(raw, &rows) != nil {
			return rowDoc{}, decodeErr("invalid fieldOrigins")
		}
		for _, rawOrigin := range rows {
			var origin originDoc
			if json.Unmarshal(rawOrigin, &origin) != nil || origin.Address.Kind == "" {
				return rowDoc{}, decodeErr("invalid field origin")
			}
			var wrapped map[string]json.RawMessage
			_ = json.Unmarshal(rawOrigin, &wrapped)
			origin.rawAddr = wrapped["address"]
			doc.origins = append(doc.origins, origin)
		}
	}
	if raw, ok := top["ai"]; ok && string(bytes.TrimSpace(raw)) != "null" {
		if json.Unmarshal(raw, &doc.ai) != nil {
			return rowDoc{}, decodeErr("invalid ai")
		}
		if doc.ai.Candidates == nil {
			doc.ai.Candidates = []candidate{}
		}
	}
	return doc, nil
}

func decodeDraft(raw json.RawMessage) (draftDoc, error) {
	var body struct {
		Values  map[string]json.RawMessage `json:"values"`
		Complex []complexGroup             `json:"complex_values"`
		Cleared []string                   `json:"cleared"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return draftDoc{}, decodeErr("invalid draft")
	}
	if body.Values == nil {
		body.Values = map[string]json.RawMessage{}
	}
	for _, value := range body.Values {
		if err := checkDraftValue(value); err != nil {
			return draftDoc{}, err
		}
	}
	return draftDoc{values: body.Values, complex: body.Complex, cleared: body.Cleared}, nil
}

func checkDraftValue(raw json.RawMessage) error {
	var body struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return decodeErr("invalid draft value")
	}
	switch body.Kind {
	case "text", "text_list", "integer", "integer_list", "decimal", "decimal_list",
		"boolean", "boolean_list", "single_select", "multi_select", "url", "url_list":
		return nil
	default:
		return decodeErr("unknown draft value kind")
	}
}

type decodeFailure struct{ detail string }

func (e decodeFailure) Error() string { return PayloadDecodePrefix + e.detail }

func decodeErr(detail string) error { return decodeFailure{detail} }
