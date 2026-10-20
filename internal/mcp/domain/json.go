package domain

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strconv"
)

const (
	maxCodeBytes  = 32 * 1024
	maxInputBytes = 64 * 1024
	safeInteger   = 9_007_199_254_740_991
)

// Canonical rewrites JSON with object keys sorted and HTML escaping off.
func Canonical(raw []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return marshalSorted(v)
}

func marshalSorted(v any) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeSorted(&buf, v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeSorted(buf *bytes.Buffer, v any) error {
	switch n := v.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		if n {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case json.Number:
		buf.WriteString(n.String())
	case string:
		raw, err := json.Marshal(n)
		if err != nil {
			return err
		}
		buf.Write(raw)
	case []any:
		buf.WriteByte('[')
		for i, item := range n {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeSorted(buf, item); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(n))
		for k := range n {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			raw, err := json.Marshal(k)
			if err != nil {
				return err
			}
			buf.Write(raw)
			buf.WriteByte(':')
			if err := writeSorted(buf, n[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	default:
		raw, err := json.Marshal(n)
		if err != nil {
			return err
		}
		buf.Write(raw)
	}
	return nil
}

// CheckJSON rejects integers outside the JavaScript safe range and nesting over 64.
func CheckJSON(v any, depth int) *HostError {
	if depth > 64 {
		return NewHost("invalid_json", "JSON nesting exceeds 64 levels")
	}
	switch n := v.(type) {
	case json.Number:
		if !safeNumber(n) {
			return NewHost("invalid_json", "JSON integers must stay within the JavaScript safe integer range")
		}
	case []any:
		for _, item := range n {
			if err := CheckJSON(item, depth+1); err != nil {
				return err
			}
		}
	case map[string]any:
		for _, item := range n {
			if err := CheckJSON(item, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

func safeNumber(n json.Number) bool {
	if i, err := n.Int64(); err == nil {
		if i < 0 {
			i = -i
		}
		return uint64(i) <= safeInteger
	}
	f, err := n.Float64()
	if err != nil || f != f || f > f { // NaN or Inf: f != f, and Inf comparison
		return false
	}
	if f < 0 {
		f = -f
	}
	return f <= safeInteger
}

// RequestDigest is SHA-256 hex of canonical {"catalogVersion","code","input"}.
func RequestDigest(code, version string, input json.RawMessage) (string, *HostError) {
	if len(code) > maxCodeBytes {
		return "", NewHost("code_too_large", "Code exceeds 32 KiB")
	}
	if len(input) == 0 {
		input = json.RawMessage("null")
	}
	checked, err := decodeAny(input)
	if err != nil {
		return "", NewHost("invalid_json", "JSON integers must stay within the JavaScript safe integer range")
	}
	if herr := CheckJSON(checked, 0); herr != nil {
		return "", herr
	}
	canon, err := marshalSorted(checked)
	if err != nil {
		return "", NewHost("invalid_json", "JSON integers must stay within the JavaScript safe integer range")
	}
	if len(canon) > maxInputBytes {
		return "", NewHost("payload_too_large", "JSON payload exceeds its limit")
	}
	body, err := marshalSorted(map[string]any{
		"catalogVersion": version,
		"code":           code,
		"input":          checked,
	})
	if err != nil {
		return "", NewHost("execution_finish_unavailable", "Execution recovery is required; inspect its current status")
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:]), nil
}

// SHA256Hex hashes raw bytes.
func SHA256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func decodeAny(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

// HashToken is SHA-256 lowercase hex of the bearer token.
func HashToken(token string) string { return SHA256Hex([]byte(token)) }

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
