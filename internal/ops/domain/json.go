package domain

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

func itoa(n int) string { return strconv.Itoa(n) }

func object(raw []byte, allowed ...string) (map[string]json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, errJSON
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var m map[string]json.RawMessage
	if err := dec.Decode(&m); err != nil {
		return nil, errJSON
	}
	if dec.More() {
		return nil, errJSON
	}
	ok := map[string]struct{}{}
	for _, k := range allowed {
		ok[k] = struct{}{}
	}
	for k := range m {
		if _, allowed := ok[k]; !allowed {
			return nil, errJSON
		}
	}
	return m, nil
}

var errJSON = json.Unmarshal([]byte("{"), new(struct{}))

func rawString(m map[string]json.RawMessage, key string) (string, bool, error) {
	raw, ok := m[key]
	if !ok {
		return "", false, nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", true, errJSON
	}
	return s, true, nil
}

func rawI64(m map[string]json.RawMessage, key string) (int64, bool, error) {
	raw, ok := m[key]
	if !ok || string(raw) == "null" {
		return 0, false, nil
	}
	var n json.Number
	if err := json.Unmarshal(raw, &n); err != nil {
		return 0, true, errJSON
	}
	v, err := n.Int64()
	if err != nil {
		return 0, true, errJSON
	}
	return v, true, nil
}

func rawBool(m map[string]json.RawMessage, key string) (bool, bool, error) {
	raw, ok := m[key]
	if !ok || string(raw) == "null" {
		return false, false, nil
	}
	var v bool
	if err := json.Unmarshal(raw, &v); err != nil {
		return false, true, errJSON
	}
	return v, true, nil
}

func optString(m map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := m[key]
	if !ok || string(raw) == "null" {
		return nil, nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, errJSON
	}
	return &s, nil
}

func optI64(m map[string]json.RawMessage, key string) (*int64, error) {
	v, ok, err := rawI64(m, key)
	if err != nil || !ok {
		return nil, err
	}
	return &v, nil
}

// PositiveI64 accepts a decimal integer in 1..=MaxInt64. Leading junk is refused.
func PositiveI64(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" || s[0] == '+' || s[0] == '-' {
		return 0, false
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}

// NormalizeUUID is the 36-character hex form. Anything else is "store missing".
func NormalizeUUID(s string) (string, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) != 36 {
		return "", false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return "", false
			}
			continue
		}
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return "", false
		}
	}
	return s, true
}

func compact(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func jsonMessage(body string) string {
	var m struct {
		Message string `json:"message"`
	}
	if json.Unmarshal([]byte(body), &m) != nil {
		return ""
	}
	return m.Message
}

func asObject(body string) map[string]json.RawMessage {
	var m map[string]json.RawMessage
	if json.Unmarshal([]byte(body), &m) != nil {
		return nil
	}
	return m
}

func nested(m map[string]json.RawMessage, key string) map[string]json.RawMessage {
	raw, ok := m[key]
	if !ok {
		return nil
	}
	var child map[string]json.RawMessage
	if json.Unmarshal(raw, &child) != nil {
		return nil
	}
	return child
}

func arr(m map[string]json.RawMessage, key string) []map[string]json.RawMessage {
	raw, ok := m[key]
	if !ok {
		return nil
	}
	var rows []map[string]json.RawMessage
	if json.Unmarshal(raw, &rows) != nil {
		return nil
	}
	return rows
}

func fieldString(m map[string]json.RawMessage, key string) string {
	s, _, _ := rawString(m, key)
	return s
}

func fieldI64(m map[string]json.RawMessage, key string) int64 {
	var n json.Number
	raw, ok := m[key]
	if !ok {
		return 0
	}
	if json.Unmarshal(raw, &n) == nil {
		if v, err := n.Int64(); err == nil {
			return v
		}
		if v, err := n.Float64(); err == nil {
			return int64(v)
		}
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		v, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
		return v
	}
	return 0
}

func fieldF64(m map[string]json.RawMessage, key string) float64 {
	raw, ok := m[key]
	if !ok {
		return 0
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		v, _ := n.Float64()
		return v
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		v, _ := strconv.ParseFloat(s, 64)
		return v
	}
	return 0
}
