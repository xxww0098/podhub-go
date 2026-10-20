package api

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
)

// marshalJSON writes compact JSON: struct field order, map keys sorted, no
// HTML escaping, no trailing newline.
func marshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	raw := buf.Bytes()
	if len(raw) > 0 && raw[len(raw)-1] == '\n' {
		raw = raw[:len(raw)-1]
	}
	return raw, nil
}

// canonicalJSON re-encodes a jsonb value through marshalJSON: object keys
// sorted, number text kept. PostgreSQL's jsonb text has spaces; the wire
// format does not.
func canonicalJSON(raw []byte) (json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return json.RawMessage(`{}`), nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	out, err := marshalJSON(v)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(out), nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	raw, err := marshalJSON(body)
	if err != nil {
		slog.Error("json encode", "err", err)
		http.Error(w, "服务暂不可用", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write(raw); err != nil {
		slog.Error("json write", "err", err)
	}
}
