package domain

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// DocError is a card-document refusal. Kind is validation or conflict.
// The message is the Rust sentence, including the card_payload wrapper.
type DocError struct {
	Kind    string
	Message string
}

func (e DocError) Error() string { return e.Message }

const (
	docPrefix   = "上架方案载荷不是可用的方案文档：listing card payload decode: "
	psdMismatch = "PSD 模板引用与固定摘要不一致"
	psdDigest   = "PSD 固定摘要格式无效"
)

var cardFields = map[string]bool{
	"categoryKey": true, "descriptionCategoryId": true, "typeId": true,
	"language": true, "defaults": true, "aiPromptId": true, "aiPromptSha256": true,
	"supplierProductId": true, "psdTemplateAssetId": true, "psdTemplateSha256": true,
	"psdTemplateFileName": true, "aiFieldPolicy": true, "videos": true,
	"videoCover": true, "queue": true,
}

var annotationKeys = []string{
	"aiPrompt", "aiPromptFileName", "targetStoreId", "supplierUnavailable", "size",
}

var systemMediaKeys = map[string]bool{
	"attribute_21837": true, "attribute_21841": true, "attribute_22273": true, "attribute_21845": true,
}

// PrepareCard decodes a card payload, drops retired schemaRevision, refuses
// unknown keys, strips or refuses system-media defaults, fills the paint
// theme, and checks the PSD digest pair. storedDefaults is the server copy
// (nil for a new card). The returned bytes are the document to store.
func PrepareCard(raw json.RawMessage, storedDefaults json.RawMessage) ([]byte, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, DocError{Kind: "validation", Message: docPrefix + "invalid type: null, expected struct CardPayload"}
	}
	keys, vals, ok := parseObject(trimmed)
	if !ok {
		return nil, DocError{Kind: "validation", Message: docPrefix + "invalid type: expected struct CardPayload"}
	}
	annotations := map[string]json.RawMessage{}
	for _, key := range annotationKeys {
		if v, exists := vals[key]; exists {
			annotations[key] = v
			delete(vals, key)
		}
	}
	halt := takeHalt(vals)
	delete(vals, "schemaRevision")
	var unknown []string
	seen := map[string]bool{}
	for _, key := range keys {
		if key == "schemaRevision" || annotations[key] != nil || key == "queue" {
			continue
		}
		if !cardFields[key] && !seen[key] {
			unknown = append(unknown, key)
			seen[key] = true
		}
	}
	if len(unknown) > 0 {
		return nil, DocError{Kind: "validation", Message: docPrefix + "unknown fields: " + strings.Join(unknown, ", ")}
	}
	doc, err := readCard(vals)
	if err != nil {
		return nil, err
	}
	if err := admitDefaults(&doc, storedDefaults); err != nil {
		return nil, err
	}
	paintTheme(&doc)
	if err := checkPSD(doc.PSDAsset, doc.PSDSHA); err != nil {
		return nil, err
	}
	return encodeCard(doc, annotations, halt)
}

type cardDoc struct {
	CategoryKey string
	Category    int64
	TypeID      int64
	Language    string
	Defaults    json.RawMessage
	PromptID    string
	PromptSHA   string
	Supplier    *string
	PSDAsset    string
	PSDSHA      string
	PSDName     string
	Policy      json.RawMessage
	Videos      json.RawMessage
	Cover       json.RawMessage
	Queue       json.RawMessage
}

func readCard(vals map[string]json.RawMessage) (cardDoc, error) {
	var doc cardDoc
	if _, ok := vals["categoryKey"]; !ok {
		return doc, DocError{Kind: "validation", Message: docPrefix + "missing field `categoryKey`"}
	}
	if err := json.Unmarshal(vals["categoryKey"], &doc.CategoryKey); err != nil {
		return doc, DocError{Kind: "validation", Message: docPrefix + "invalid type: expected a string for categoryKey"}
	}
	if _, ok := vals["descriptionCategoryId"]; !ok {
		return doc, DocError{Kind: "validation", Message: docPrefix + "missing field `descriptionCategoryId`"}
	}
	if err := unmarshalI64(vals["descriptionCategoryId"], &doc.Category); err != nil {
		return doc, DocError{Kind: "validation", Message: docPrefix + "invalid type: expected i64 for descriptionCategoryId"}
	}
	if _, ok := vals["typeId"]; !ok {
		return doc, DocError{Kind: "validation", Message: docPrefix + "missing field `typeId`"}
	}
	if err := unmarshalI64(vals["typeId"], &doc.TypeID); err != nil {
		return doc, DocError{Kind: "validation", Message: docPrefix + "invalid type: expected i64 for typeId"}
	}
	doc.Language = "default"
	if raw, ok := vals["language"]; ok && string(bytes.TrimSpace(raw)) != "null" {
		if err := json.Unmarshal(raw, &doc.Language); err != nil {
			return doc, DocError{Kind: "validation", Message: docPrefix + "invalid type: expected a string for language"}
		}
		switch doc.Language {
		case "default", "ru", "en", "tr", "zh_hans":
		default:
			return doc, DocError{Kind: "validation", Message: docPrefix + "unknown variant `" + doc.Language + "`, expected one of `default`, `ru`, `en`, `tr`, `zh_hans`"}
		}
	}
	doc.Defaults = json.RawMessage(`{"values":{},"complex_values":[]}`)
	if raw, ok := vals["defaults"]; ok && string(bytes.TrimSpace(raw)) != "null" {
		if !isObject(raw) {
			return doc, DocError{Kind: "validation", Message: docPrefix + "invalid type: expected a map for defaults"}
		}
		doc.Defaults = raw
	}
	if raw, ok := vals["aiPromptId"]; ok {
		_ = json.Unmarshal(raw, &doc.PromptID)
	}
	if raw, ok := vals["aiPromptSha256"]; ok {
		_ = json.Unmarshal(raw, &doc.PromptSHA)
	}
	if raw, ok := vals["supplierProductId"]; ok && string(bytes.TrimSpace(raw)) != "null" {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return doc, DocError{Kind: "validation", Message: docPrefix + "invalid type: expected a string for supplierProductId"}
		}
		doc.Supplier = &s
	}
	if raw, ok := vals["psdTemplateAssetId"]; ok {
		_ = json.Unmarshal(raw, &doc.PSDAsset)
	}
	if raw, ok := vals["psdTemplateSha256"]; ok {
		_ = json.Unmarshal(raw, &doc.PSDSHA)
	}
	if raw, ok := vals["psdTemplateFileName"]; ok {
		_ = json.Unmarshal(raw, &doc.PSDName)
	}
	if _, ok := vals["aiFieldPolicy"]; !ok {
		return doc, DocError{Kind: "validation", Message: docPrefix + "missing field `aiFieldPolicy`"}
	}
	if !isObject(vals["aiFieldPolicy"]) {
		return doc, DocError{Kind: "validation", Message: docPrefix + "invalid type: expected a map for aiFieldPolicy"}
	}
	doc.Policy = vals["aiFieldPolicy"]
	doc.Videos = json.RawMessage(`[]`)
	if raw, ok := vals["videos"]; ok && string(bytes.TrimSpace(raw)) != "null" {
		doc.Videos = raw
	}
	if raw, ok := vals["videoCover"]; ok && string(bytes.TrimSpace(raw)) != "null" {
		doc.Cover = raw
	}
	doc.Queue = json.RawMessage(`{"paused":false,"stopAfterCurrent":false,"nextPosition":0,"frozenRowIds":[]}`)
	if raw, ok := vals["queue"]; ok && string(bytes.TrimSpace(raw)) != "null" {
		if !isObject(raw) {
			return doc, DocError{Kind: "validation", Message: "queue 格式无效"}
		}
		doc.Queue = raw
	}
	return doc, nil
}

func admitDefaults(doc *cardDoc, stored json.RawMessage) error {
	keys, vals, complex, cleared, ok := draftParts(doc.Defaults)
	if !ok {
		return DocError{Kind: "validation", Message: docPrefix + "invalid type: expected a map for defaults"}
	}
	var named []string
	for _, key := range keys {
		if !systemMediaKeys[key] {
			continue
		}
		if storedHolds(stored, key, vals[key]) {
			delete(vals, key)
			continue
		}
		named = append(named, "字段 "+key)
	}
	for _, key := range cleared {
		if systemMediaKeys[key] && !storedClears(stored, key) {
			named = append(named, "字段 "+key+" 的清空")
		}
	}
	for _, group := range complex {
		if group == 100001 || group == 100002 {
			named = append(named, "系统媒体组 "+strconv.FormatInt(group, 10))
		}
	}
	if len(named) > 0 {
		return DocError{Kind: "validation", Message: "系统媒体由发送时的媒体证据填写，方案默认值不能新增或修改：" + strings.Join(named, "、") + "。请在方案默认值中删除这些字段或组后重新保存；视频和封面请在方案媒体中上传"}
	}
	doc.Defaults = encodeDraft(vals, complexGroups(doc.Defaults), cleared)
	return nil
}

func paintTheme(doc *cardDoc) {
	if doc.TypeID != 94897 {
		return
	}
	_, vals, _, cleared, ok := draftParts(doc.Defaults)
	if !ok {
		return
	}
	for _, key := range cleared {
		if key == "attribute_7109" {
			return
		}
	}
	raw := vals["attribute_7109"]
	if len(bytes.TrimSpace(raw)) > 0 && string(bytes.TrimSpace(raw)) != "null" {
		return
	}
	vals["attribute_7109"] = json.RawMessage(`{"kind":"multi_select","value":[{"dictionary_value_id":31229,"value":"抽象化"}]}`)
	doc.Defaults = encodeDraft(vals, complexGroups(doc.Defaults), cleared)
}

func checkPSD(asset, digest string) error {
	if asset != "" && asset != digest {
		return DocError{Kind: "conflict", Message: psdMismatch}
	}
	if digest == "" {
		return nil
	}
	if len(digest) != 64 || strings.IndexFunc(digest, func(r rune) bool {
		return (r < '0' || r > '9') && (r < 'a' || r > 'f')
	}) >= 0 {
		return DocError{Kind: "validation", Message: psdDigest}
	}
	return nil
}

func encodeCard(doc cardDoc, annotations map[string]json.RawMessage, halt json.RawMessage) ([]byte, error) {
	policy := normalizePolicy(doc.Policy)
	queue := doc.Queue
	if len(halt) > 0 {
		queue = putKey(queue, "haltReason", halt)
	}
	body := map[string]any{
		"categoryKey": doc.CategoryKey, "descriptionCategoryId": doc.Category, "typeId": doc.TypeID,
		"language": doc.Language, "defaults": json.RawMessage(doc.Defaults),
		"aiPromptId": doc.PromptID, "aiPromptSha256": doc.PromptSHA,
		"psdTemplateAssetId": doc.PSDAsset, "psdTemplateSha256": doc.PSDSHA, "psdTemplateFileName": doc.PSDName,
		"aiFieldPolicy": json.RawMessage(policy), "videos": json.RawMessage(doc.Videos), "queue": json.RawMessage(queue),
	}
	if doc.Supplier != nil {
		body["supplierProductId"] = *doc.Supplier
	}
	if len(doc.Cover) > 0 {
		body["videoCover"] = json.RawMessage(doc.Cover)
	}
	for key, value := range annotations {
		body[key] = json.RawMessage(value)
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, DocError{Kind: "validation", Message: docPrefix + err.Error()}
	}
	return raw, nil
}

func normalizePolicy(raw json.RawMessage) json.RawMessage {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return json.RawMessage(`{"allowed_field_keys":[],"protected_field_keys":[]}`)
	}
	if obj["allowed_field_keys"] == nil {
		obj["allowed_field_keys"] = json.RawMessage(`[]`)
	}
	if obj["protected_field_keys"] == nil {
		obj["protected_field_keys"] = json.RawMessage(`[]`)
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return json.RawMessage(`{"allowed_field_keys":[],"protected_field_keys":[]}`)
	}
	return out
}

func draftParts(raw json.RawMessage) (keys []string, vals map[string]json.RawMessage, complex []int64, cleared []string, ok bool) {
	objKeys, obj, good := parseObject(raw)
	if !good {
		return nil, nil, nil, nil, false
	}
	vals = map[string]json.RawMessage{}
	if v, exists := obj["values"]; exists && isObject(v) {
		keys, vals, _ = parseObject(v)
	}
	if v, exists := obj["complex_values"]; exists {
		var groups []struct {
			ID int64 `json:"complex_id"`
		}
		_ = json.Unmarshal(v, &groups)
		for _, group := range groups {
			complex = append(complex, group.ID)
		}
	}
	if v, exists := obj["cleared"]; exists {
		_ = json.Unmarshal(v, &cleared)
	}
	_ = objKeys
	return keys, vals, complex, cleared, true
}

func complexGroups(raw json.RawMessage) json.RawMessage {
	_, obj, ok := parseObject(raw)
	if !ok {
		return json.RawMessage(`[]`)
	}
	if v, exists := obj["complex_values"]; exists {
		return v
	}
	return json.RawMessage(`[]`)
}

func encodeDraft(vals map[string]json.RawMessage, complex json.RawMessage, cleared []string) json.RawMessage {
	body := map[string]any{"values": vals, "complex_values": json.RawMessage(complex)}
	if len(cleared) > 0 {
		body["cleared"] = cleared
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return json.RawMessage(`{"values":{},"complex_values":[]}`)
	}
	return raw
}

func storedHolds(stored json.RawMessage, key string, next json.RawMessage) bool {
	if len(stored) == 0 {
		return false
	}
	_, vals, _, _, ok := draftParts(stored)
	if !ok {
		return false
	}
	prev, exists := vals[key]
	return exists && bytes.Equal(bytes.TrimSpace(prev), bytes.TrimSpace(next))
}

func storedClears(stored json.RawMessage, key string) bool {
	if len(stored) == 0 {
		return false
	}
	_, _, _, cleared, ok := draftParts(stored)
	if !ok {
		return false
	}
	for _, item := range cleared {
		if item == key {
			return true
		}
	}
	return false
}

func takeHalt(vals map[string]json.RawMessage) json.RawMessage {
	raw, ok := vals["queue"]
	if !ok || !isObject(raw) {
		return nil
	}
	_, queue, good := parseObject(raw)
	if !good {
		return nil
	}
	halt := queue["haltReason"]
	if len(halt) == 0 {
		return nil
	}
	delete(queue, "haltReason")
	vals["queue"] = encodeObject(queue)
	return halt
}

func putKey(raw json.RawMessage, key string, value json.RawMessage) json.RawMessage {
	_, obj, ok := parseObject(raw)
	if !ok {
		obj = map[string]json.RawMessage{}
	}
	obj[key] = value
	return encodeObject(obj)
}

func encodeObject(obj map[string]json.RawMessage) json.RawMessage {
	raw, err := json.Marshal(obj)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return raw
}

func parseObject(raw []byte) ([]string, map[string]json.RawMessage, bool) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, nil, false
	}
	var keys []string
	vals := map[string]json.RawMessage{}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, nil, false
		}
		key, _ := keyTok.(string)
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, nil, false
		}
		keys = append(keys, key)
		vals[key] = value
	}
	end, err := dec.Token()
	if err != nil || end != json.Delim('}') {
		return nil, nil, false
	}
	return keys, vals, true
}

func isObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}

func unmarshalI64(raw json.RawMessage, dst *int64) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var n json.Number
	if err := dec.Decode(&n); err != nil {
		return err
	}
	v, err := n.Int64()
	if err != nil {
		return err
	}
	*dst = v
	return nil
}
