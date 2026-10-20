package domain

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"
)

func parseTime(s string) (time.Time, error) {
	return time.Parse(time.RFC3339Nano, s)
}

func compactJSON(v any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimRight(buf.String(), "\n"), nil
}

// ordered is a JSON object whose keys stay in insertion order.
type ordered struct {
	keys []string
	vals map[string]json.RawMessage
}

func (o ordered) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, key := range o.keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		kb, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		buf.Write(kb)
		buf.WriteByte(':')
		buf.Write(o.vals[key])
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

func rawString(s string) json.RawMessage {
	b, _ := json.Marshal(s)
	return b
}

func rawInt(n int64) json.RawMessage {
	b, _ := json.Marshal(n)
	return b
}

func rawBool(v bool) json.RawMessage {
	if v {
		return json.RawMessage("true")
	}
	return json.RawMessage("false")
}

func isJSONInt(n json.Number) (int64, bool) {
	s := n.String()
	if s == "" || strings.ContainsAny(s, ".eE") {
		return 0, false
	}
	v, err := n.Int64()
	return v, err == nil
}

func parseRFC3339(s string) bool {
	_, err := parseTime(s)
	return err == nil
}
