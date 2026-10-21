package domain

import (
	"bytes"
	"encoding/json"
)

// Stored issues keep their domain keys for SQL and current-issue selection.
// Only declared HTTP properties are renamed; free-form nested data is opaque.
func issueWire(raw json.RawMessage) json.RawMessage {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return raw
	}
	changed := false
	for _, names := range [][2]string{
		{"allowedActions", "allowed_actions"}, {"traceId", "trace_id"},
		{"safeMessage", "safe_message"}, {"dispatchEvidence", "dispatch_evidence"},
		{"intentId", "intent_id"}, {"inputRevision", "input_revision"},
		{"requestHash", "request_hash"}, {"rowId", "row_id"}, {"storeId", "store_id"},
		{"credentialRevision", "credential_revision"}, {"retryAfterFallback", "retry_after_fallback"},
		{"createdAtMs", "created_at_ms"}, {"httpStatus", "http_status"},
		{"providerCode", "provider_code"}, {"resolvedAtMs", "resolved_at_ms"},
		{"retryAfterMs", "retry_after_ms"},
	} {
		if value, ok := fields[names[0]]; ok {
			fields[names[1]] = value
			delete(fields, names[0])
			changed = true
		}
	}
	if !changed {
		return raw
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(fields); err != nil {
		return raw
	}
	return bytes.TrimSpace(buf.Bytes())
}

func issueHistoryWire(raw json.RawMessage) json.RawMessage {
	var issues []json.RawMessage
	if json.Unmarshal(raw, &issues) != nil || len(issues) == 0 {
		return raw
	}
	for i, issue := range issues {
		issues[i] = issueWire(issue)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(issues); err != nil {
		return raw
	}
	return bytes.TrimSpace(buf.Bytes())
}
