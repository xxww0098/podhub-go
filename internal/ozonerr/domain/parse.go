package domain

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/xxww0098/podhub-go/internal/ozonerr/contract"
)

// grpcFromHTTP is the gateway mapping for the five statuses that already
// had one. 400→3, 404→5, 403→7, 401→16, 429→8. Other 4xx are not in this map.
func grpcFromHTTP(status int) (string, bool) {
	switch status {
	case 400:
		return "3", true
	case 404:
		return "5", true
	case 403:
		return "7", true
	case 401:
		return "16", true
	case 429:
		return "8", true
	default:
		return "", false
	}
}

func grpcAllowed(code int64) bool {
	switch code {
	case 3, 5, 7, 8, 16:
		return true
	default:
		return false
	}
}

// ResolveGRPC picks the catalog code for a 4xx. An allowed gateway code
// (3, 5, 7, 8, 16) wins on every 4xx, including 422. The five mapped HTTP
// statuses otherwise keep their existing codes, even when the body carries
// some other integer. Any other 4xx stores a positive gateway code when
// the body has one, and otherwise stores the decimal HTTP status. The
// request body is not part of the result. 2xx and 5xx are not stored.
func ResolveGRPC(status int, explicit *int64) (string, bool) {
	if status < 400 || status > 499 {
		return "", false
	}
	if explicit != nil && grpcAllowed(*explicit) {
		return strconv.FormatInt(*explicit, 10), true
	}
	if code, ok := grpcFromHTTP(status); ok {
		return code, true
	}
	if explicit != nil && *explicit > 0 {
		return strconv.FormatInt(*explicit, 10), true
	}
	return strconv.Itoa(status), true
}

// RequestFromReport reads gateway.code, gateway.message, and a positive
// task id from a browser report. Other fields, including any request body,
// are ignored. ok is false when this report is not a 4xx. TaskKey is the
// shared idempotency key with a proxied 4xx; it is empty when the report
// names no task id.
func RequestFromReport(raw []byte, intentID string, status *int) (RequestError, bool) {
	if status == nil || strings.TrimSpace(intentID) == "" {
		return RequestError{}, false
	}
	out := RequestError{IntentID: strings.TrimSpace(intentID), HTTPStatus: *status}
	var body map[string]json.RawMessage
	if json.Unmarshal(raw, &body) == nil {
		out.TaskKey = taskKeyFromBody(body)
		if rawGateway, ok := body["gateway"]; ok {
			var gateway map[string]json.RawMessage
			if json.Unmarshal(rawGateway, &gateway) == nil {
				if codeRaw, ok := gateway["code"]; ok {
					if n, ok := intJSON(codeRaw); ok {
						out.GatewayCode = &n
					}
				}
				if msgRaw, ok := gateway["message"]; ok {
					var msg string
					if json.Unmarshal(msgRaw, &msg) == nil {
						out.Message = msg
					}
				}
			}
		}
	}
	if _, ok := ResolveGRPC(out.HTTPStatus, out.GatewayCode); !ok {
		return RequestError{}, false
	}
	return out, true
}

// ParseImportBody reads a browser import-info report. Unknown fields are
// dropped. More than MaxErrors items is refused and nothing is returned.
func ParseImportBody(raw []byte) ([]Row, error) {
	return parseItems(raw, true)
}

// ParseUpstreamItems reads an import/info response the proxy already has.
// taskKey is the decimal task id from the request. Extra items past
// MaxErrors are dropped so the proxy response is still returned.
func ParseUpstreamItems(taskKey string, raw []byte) []Row {
	rows, err := parseItems(mergeTask(taskKey, raw), false)
	if err != nil {
		return nil
	}
	return rows
}

// SharedTaskKey is the decimal task id used by both a browser report and a
// proxied 4xx. Leading zeros and non-decimal text are rejected so the two
// paths cannot miss each other on formatting. Empty means there is no
// shared key: the browser sighting stays on the intent id.
func SharedTaskKey(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > MaxTaskKey {
		return ""
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 || strconv.FormatInt(n, 10) != raw {
		return ""
	}
	return raw
}

func taskKeyFromBody(body map[string]json.RawMessage) string {
	for _, key := range []string{"taskId", "task_id"} {
		rawID, ok := body[key]
		if !ok {
			continue
		}
		n, ok := intJSON(rawID)
		if ok && n > 0 {
			return SharedTaskKey(strconv.FormatInt(n, 10))
		}
	}
	return ""
}

// TaskID reads a positive task_id or taskId and ignores every other field.
func TaskID(raw []byte) (string, bool) {
	var body map[string]json.RawMessage
	if json.Unmarshal(raw, &body) != nil {
		return "", false
	}
	for _, key := range []string{"task_id", "taskId"} {
		rawID, ok := body[key]
		if !ok {
			continue
		}
		n, ok := intJSON(rawID)
		if ok && n > 0 {
			return strconv.FormatInt(n, 10), true
		}
	}
	return "", false
}

// GatewayRow is one request-layer observation for a proxied 4xx.
// The request body is not read. details is ignored.
func GatewayRow(taskKey string, status int, body []byte) (Row, bool) {
	if taskKey == "" || status < 400 || status > 499 {
		return Row{}, false
	}
	var explicit *int64
	var message string
	var payload map[string]json.RawMessage
	if json.Unmarshal(body, &payload) == nil {
		if rawCode, ok := payload["code"]; ok {
			if n, ok := intJSON(rawCode); ok {
				explicit = &n
			}
		}
		if rawMsg, ok := payload["message"]; ok {
			_ = json.Unmarshal(rawMsg, &message)
		}
	}
	code, ok := ResolveGRPC(status, explicit)
	if !ok {
		return Row{}, false
	}
	return Row{
		Source:  SourceRequest,
		Code:    code,
		Sample:  Redact(message),
		TaskKey: taskKey,
	}, true
}

func mergeTask(taskKey string, raw []byte) []byte {
	var body map[string]json.RawMessage
	if json.Unmarshal(raw, &body) != nil {
		return []byte(`{"taskId":` + taskKey + `}`)
	}
	body["taskId"] = json.RawMessage(taskKey)
	out, err := json.Marshal(body)
	if err != nil {
		return raw
	}
	return out
}

func parseItems(raw []byte, strict bool) ([]Row, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var body map[string]any
	if err := dec.Decode(&body); err != nil {
		if strict {
			return nil, contract.ErrBadBody
		}
		return nil, nil
	}
	if result, ok := body["result"].(map[string]any); ok {
		if _, has := body["items"]; !has {
			if items, ok := result["items"]; ok {
				body["items"] = items
			}
		}
		if _, has := body["errors"]; !has {
			if errs, ok := result["errors"]; ok {
				body["errors"] = errs
			}
		}
	}
	taskKey, ok := positiveString(body["taskId"])
	if !ok {
		taskKey, ok = positiveString(body["task_id"])
	}
	if !ok || len(taskKey) > MaxTaskKey {
		if strict {
			return nil, contract.ErrBadBody
		}
		return nil, nil
	}
	defaultOffer := clip(stringField(body, "offerId", "offer_id"), MaxOffer)
	defaultCat := nonNeg(body["descriptionCategoryId"], body["description_category_id"])
	defaultType := nonNeg(body["typeId"], body["type_id"])
	var items []itemIn
	if rawItems, ok := body["items"].([]any); ok {
		for _, rawItem := range rawItems {
			obj, ok := rawItem.(map[string]any)
			if !ok {
				continue
			}
			items = append(items, itemIn{
				offer: firstNonEmpty(clip(stringField(obj, "offerId", "offer_id"), MaxOffer), defaultOffer),
				cat:   firstNonNeg(nonNeg(obj["descriptionCategoryId"], obj["description_category_id"]), defaultCat),
				typ:   firstNonNeg(nonNeg(obj["typeId"], obj["type_id"]), defaultType),
				errs:  errorList(obj["errors"]),
			})
		}
	} else if errs := errorList(body["errors"]); len(errs) > 0 {
		items = append(items, itemIn{offer: defaultOffer, cat: defaultCat, typ: defaultType, errs: errs})
	}
	var total int
	for _, item := range items {
		total += len(item.errs)
	}
	if total > MaxErrors {
		if strict {
			return nil, contract.ErrTooMany
		}
	}
	var rows []Row
	for _, item := range items {
		for _, errItem := range item.errs {
			if len(rows) >= MaxErrors {
				return rows, nil
			}
			row, ok := buildRow(taskKey, item, errItem)
			if ok {
				rows = append(rows, row)
			}
		}
	}
	return rows, nil
}

type itemIn struct {
	offer string
	cat   int64
	typ   int64
	errs  []map[string]any
}

func errorList(raw any) []map[string]any {
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	var out []map[string]any
	for _, item := range list {
		obj, ok := item.(map[string]any)
		if ok {
			out = append(out, obj)
		}
	}
	return out
}

func buildRow(taskKey string, item itemIn, obj map[string]any) (Row, bool) {
	code := clip(stringField(obj, "code"), MaxCode)
	if code == "" || SecretCode(code) {
		return Row{}, false
	}
	attr, ok := nonNegOK(firstPresent(obj, "attribute_id", "attributeId"))
	if !ok {
		return Row{}, false
	}
	row := Row{
		Source:                SourceImportInfo,
		Code:                  code,
		AttributeID:           attr,
		DescriptionCategoryID: item.cat,
		TypeID:                item.typ,
		Level:                 Redact(clip(stringField(obj, "level"), MaxLevel)),
		State:                 Redact(clip(stringField(obj, "state"), MaxState)),
		Field:                 Redact(clip(stringField(obj, "field"), MaxField)),
		AttributeName:         Redact(clip(stringField(obj, "attribute_name", "attributeName"), MaxName)),
		Sample:                Redact(stringField(obj, "description")),
		TaskKey:               taskKey,
		OfferKey:              item.offer,
	}
	if SecretCode(row.Level) || SecretCode(row.State) || SecretCode(row.Field) || SecretCode(row.AttributeName) {
		return Row{}, false
	}
	return row, true
}

func stringField(obj map[string]any, keys ...string) string {
	for _, key := range keys {
		raw, ok := obj[key]
		if !ok || raw == nil {
			continue
		}
		switch v := raw.(type) {
		case string:
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func firstPresent(obj map[string]any, keys ...string) any {
	for _, key := range keys {
		if raw, ok := obj[key]; ok {
			return raw
		}
	}
	return nil
}

func clip(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}

func positiveString(raw any) (string, bool) {
	n, ok := asInt(raw)
	if !ok || n <= 0 {
		return "", false
	}
	return strconv.FormatInt(n, 10), true
}

func nonNeg(values ...any) int64 {
	for _, raw := range values {
		if raw == nil {
			continue
		}
		n, ok := asInt(raw)
		if ok && n >= 0 {
			return n
		}
	}
	return 0
}

func nonNegOK(raw any) (int64, bool) {
	if raw == nil {
		return 0, true
	}
	n, ok := asInt(raw)
	if !ok || n < 0 {
		return 0, false
	}
	return n, true
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func firstNonNeg(a, b int64) int64 {
	if a > 0 {
		return a
	}
	return b
}

func asInt(raw any) (int64, bool) {
	switch v := raw.(type) {
	case json.Number:
		n, err := v.Int64()
		return n, err == nil
	case float64:
		if v != float64(int64(v)) {
			return 0, false
		}
		return int64(v), true
	case string:
		n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		return n, err == nil
	default:
		return 0, false
	}
}

func intJSON(raw json.RawMessage) (int64, bool) {
	var n json.Number
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&n); err != nil {
		return 0, false
	}
	v, err := n.Int64()
	return v, err == nil
}
