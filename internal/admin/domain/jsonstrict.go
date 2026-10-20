package domain

import (
	"bytes"
	"encoding/json"
	"io"
)

// decodeStrict rejects unknown fields and a second JSON value.
// Relay import uses it; the shipping rules keep their own copy.
func decodeStrict(raw []byte, dst any) *APIError {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return Fail(400, "VALIDATION", "请求格式无效")
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return Fail(400, "VALIDATION", "请求格式无效")
	}
	return nil
}

func has(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}
