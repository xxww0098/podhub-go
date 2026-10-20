package contract

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
)

// ErrJSON is the strict-object decode failure. Callers only test it for nil.
var ErrJSON = errors.New("json")

// StrictObject decodes one JSON object and rejects trailing data.
func StrictObject(body []byte) (map[string]json.RawMessage, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		return nil, ErrJSON
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var raw map[string]json.RawMessage
	if err := dec.Decode(&raw); err != nil || raw == nil || dec.More() {
		return nil, ErrJSON
	}
	return raw, nil
}

// HasOnly reports whether every key of raw is in allow.
func HasOnly(raw map[string]json.RawMessage, allow []string) bool {
	ok := map[string]bool{}
	for _, k := range allow {
		ok[k] = true
	}
	for k := range raw {
		if !ok[k] {
			return false
		}
	}
	return true
}

// RequireKeys reports whether every key is present.
func RequireKeys(raw map[string]json.RawMessage, keys []string) bool {
	for _, k := range keys {
		if _, ok := raw[k]; !ok {
			return false
		}
	}
	return true
}

// Unmarshal decodes raw into dest and rejects trailing data.
func Unmarshal(raw json.RawMessage, dest any) bool {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(dest); err != nil {
		return false
	}
	return !dec.More()
}

// JSONText encodes v with HTML left intact and no trailing newline.
func JSONText(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return ""
	}
	return strings.TrimRight(buf.String(), "\n")
}
