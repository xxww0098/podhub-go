package domain

import (
	"bytes"
	"encoding/json"
	"strings"
)

// WireItem is one EventInboxWireItem. Unknown JSON fields are rejected by DecodeInbox.
type WireItem struct {
	ID            string  `json:"id"`
	Kind          string  `json:"kind"`
	PayloadJSON   *string `json:"payload_json,omitempty"`
	CreatedAt     *string `json:"created_at,omitempty"`
	SchemaVersion *int32  `json:"schema_version,omitempty"`
}

// InboxRequest is the POST body.
type InboxRequest struct {
	Events []WireItem `json:"events"`
}

// AcceptedEvent is one row that may be written. Payload is canonical JSON text.
type AcceptedEvent struct {
	ID              string
	Kind            string
	Payload         string
	SchemaVersion   int32
	ClientCreatedAt string
}

// RejectedEvent is one item that stays out of the table. HTTP remains 200.
type RejectedEvent struct {
	ID     string
	Reason string
}

// DecodeInbox rejects missing JSON, unknown fields, and wrong types.
// The HTTP layer maps every error to 请求格式无效.
func DecodeInbox(body []byte) (InboxRequest, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	dec.UseNumber()
	var raw struct {
		Events []json.RawMessage `json:"events"`
	}
	if err := dec.Decode(&raw); err != nil {
		return InboxRequest{}, err
	}
	if err := dec.Decode(&struct{}{}); err != nil && err.Error() != "EOF" {
		return InboxRequest{}, err
	}
	if raw.Events == nil {
		return InboxRequest{}, errJSON
	}
	out := InboxRequest{Events: make([]WireItem, 0, len(raw.Events))}
	for _, item := range raw.Events {
		ev, err := decodeWireItem(item)
		if err != nil {
			return InboxRequest{}, err
		}
		out.Events = append(out.Events, ev)
	}
	return out, nil
}

var errJSON = bytes.ErrTooLarge // reused only as a non-nil sentinel; callers ignore the text

func decodeWireItem(raw json.RawMessage) (WireItem, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var probe struct {
		ID            string          `json:"id"`
		Kind          string          `json:"kind"`
		PayloadJSON   *string         `json:"payload_json"`
		CreatedAt     *string         `json:"created_at"`
		SchemaVersion json.RawMessage `json:"schema_version"`
	}
	if err := dec.Decode(&probe); err != nil {
		return WireItem{}, err
	}
	item := WireItem{ID: probe.ID, Kind: probe.Kind, PayloadJSON: probe.PayloadJSON, CreatedAt: probe.CreatedAt}
	if len(probe.SchemaVersion) > 0 && string(probe.SchemaVersion) != "null" {
		n, ok := int32Number(probe.SchemaVersion)
		if !ok {
			return WireItem{}, errJSON
		}
		item.SchemaVersion = &n
	}
	return item, nil
}

func int32Number(raw json.RawMessage) (int32, bool) {
	var n json.Number
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&n); err != nil {
		return 0, false
	}
	v, ok := isJSONInt(n)
	if !ok || v > int64(int32(^uint32(0)>>1)) || v < int64(-1<<31) {
		return 0, false
	}
	return int32(v), true
}

// AcceptInboxItem validates one event outside a transaction.
func AcceptInboxItem(item WireItem) (AcceptedEvent, *RejectedEvent) {
	id := strings.TrimSpace(item.ID)
	if id == "" || len(id) > EventInboxIDMaxBytes {
		shown := id
		if id == "" {
			shown = "(missing)"
		}
		return AcceptedEvent{}, &RejectedEvent{ID: shown, Reason: "id 无效"}
	}
	kind := strings.TrimSpace(item.Kind)
	if kind == "" || len(kind) > EventInboxKindMaxBytes {
		return AcceptedEvent{}, &RejectedEvent{ID: id, Reason: "kind 无效"}
	}
	payload := ""
	if item.PayloadJSON != nil {
		payload = *item.PayloadJSON
	}
	if len(payload) > EventInboxPayloadMaxBytes {
		return AcceptedEvent{}, &RejectedEvent{ID: id, Reason: "payload 超出大小限制"}
	}
	created := ""
	if item.CreatedAt != nil {
		created = *item.CreatedAt
	}
	if len(created) > EventInboxCreatedAtMaxBytes {
		return AcceptedEvent{}, &RejectedEvent{ID: id, Reason: "created_at 超出大小限制"}
	}
	schema := int32(1)
	if item.SchemaVersion != nil {
		schema = *item.SchemaVersion
	}
	if schema < 1 {
		return AcceptedEvent{}, &RejectedEvent{ID: id, Reason: "schema_version 无效"}
	}
	canonical, version, reason := acceptKind(kind, payload, schema, id, item.CreatedAt)
	if reason != "" {
		return AcceptedEvent{}, &RejectedEvent{ID: id, Reason: reason}
	}
	return AcceptedEvent{
		ID: id, Kind: kind, Payload: canonical, SchemaVersion: version, ClientCreatedAt: created,
	}, nil
}

func acceptKind(kind, payload string, schema int32, id string, created *string) (string, int32, string) {
	switch kind {
	case "error_feedback.v1":
		if schema != 1 || (created != nil && *created != "") {
			return "", 0, "error feedback envelope 无效"
		}
		text, err := decodeErrorFeedback(payload, id)
		if err != nil {
			return "", 0, "error feedback envelope 无效"
		}
		return text, 1, ""
	case "desktop_error_log.v1":
		if schema != 1 {
			return "", 0, "schema_version 必须与 desktop_error_log.v1 一致（=1）"
		}
		text, err := decodeDesktopV1(payload)
		if err != nil {
			return "", 0, err.Error()
		}
		return text, 1, ""
	case "desktop_error_log.v2":
		if schema != 2 {
			return "", 0, "schema_version 必须与 desktop_error_log.v2 一致（=2）"
		}
		text, err := decodeDesktopV2(payload)
		if err != nil {
			return "", 0, err.Error()
		}
		return text, 2, ""
	case "desktop_error_log.v3":
		if schema != 3 {
			return "", 0, "schema_version 必须与 desktop_error_log.v3 一致（=3）"
		}
		text, err := decodeDesktopV3(payload)
		if err != nil {
			return "", 0, err.Error()
		}
		return text, 3, ""
	case "desktop_error_log.v4":
		if schema != 4 {
			return "", 0, "diagnostic v4 envelope 无效"
		}
		text, err := decodeDesktopV4(payload, id)
		if err != nil {
			return "", 0, "diagnostic v4 envelope 无效"
		}
		return text, 4, ""
	case "billing.ai-token-usage.v1", "billing.object-upload-usage.v1":
		if schema != 1 {
			return "", 0, "schema_version 必须与 " + kind + " 一致（=1）"
		}
		var text string
		var err error
		if kind == "billing.ai-token-usage.v1" {
			text, err = decodeAITokens(payload)
		} else {
			text, err = decodeObjectUpload(payload)
		}
		if err != nil {
			return "", 0, err.Error()
		}
		return text, 1, ""
	default:
		return "", 0, "kind 不受支持"
	}
}

// DeviceID trims X-Podhub-Device-Id. Missing, non-text, empty, or over 128 bytes is invalid.
func DeviceID(value string, present bool) (string, bool) {
	if !present {
		return "", false
	}
	value = strings.TrimSpace(value)
	if value == "" || len(value) > EventInboxDeviceIDMaxBytes {
		return "", false
	}
	return value, true
}
