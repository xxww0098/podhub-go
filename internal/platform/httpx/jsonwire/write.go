// Package jsonwire emits serde_json::to_vec bytes: compact, struct order,
// sorted map keys, no HTML escape, no trailing newline.
package jsonwire

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
)

// Marshal encodes v the way serde_json::to_vec does.
func Marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// Write sets application/json and writes Marshal(body).
func Write(w http.ResponseWriter, status int, body any) {
	raw, err := Marshal(body)
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

// Canonical re-encodes a jsonb document. Empty input becomes {}.
func Canonical(raw []byte) (json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return json.RawMessage(`{}`), nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	out, err := Marshal(v)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(out), nil
}
