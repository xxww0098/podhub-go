package service

import "strings"

// Key checks Idempotency-Key the way src/ai/http does: trim, 1..=512 bytes,
// ASCII letters, digits, and - _ : .
func Key(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if len(raw) < 1 || len(raw) > 512 {
		return "", false
	}
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '-' || c == '_' || c == ':' || c == '.':
		default:
			return "", false
		}
	}
	return raw, true
}
