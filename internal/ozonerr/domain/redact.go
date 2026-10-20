package domain

import (
	"strings"
	"unicode/utf8"
)

// markers are looked up case-insensitively. The longest match at the
// earliest byte wins, then the surrounding token is replaced.
var markers = []string{
	"fixture-api-key",
	"api-key",
	"api_key",
	"apikey",
	"client-id",
	"client_id",
	"signature=",
	"x-amz-",
	"bearer",
	"sk-",
}

// Redact removes credential-shaped spans and then keeps at most MaxSample
// runes. Seller prose around a secret is kept. An empty input stays empty.
func Redact(s string) string {
	if s == "" || !utf8.ValidString(s) {
		return ""
	}
	out := s
	for {
		low := strings.ToLower(out)
		idx, mlen := -1, 0
		for _, marker := range markers {
			i := strings.Index(low, marker)
			if i < 0 {
				continue
			}
			if idx < 0 || i < idx || (i == idx && len(marker) > mlen) {
				idx = i
				mlen = len(marker)
			}
		}
		if idx < 0 {
			break
		}
		start := idx
		for start > 0 && start > idx-80 && tokenByte(out[start-1]) {
			start--
		}
		end := idx + mlen
		limit := end + 240
		if limit > len(out) {
			limit = len(out)
		}
		for end < limit && tokenByte(out[end]) {
			end++
		}
		out = out[:start] + "[redacted]" + out[end:]
	}
	runes := []rune(out)
	if len(runes) > MaxSample {
		runes = runes[:MaxSample]
	}
	return string(runes)
}

func tokenByte(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') ||
		b == '-' || b == '_' || b == '.' || b == ':' || b == '+' || b == '/' || b == '='
}

// SecretCode reports whether a catalog code still looks like a credential.
func SecretCode(code string) bool {
	low := strings.ToLower(code)
	for _, marker := range markers {
		if strings.Contains(low, marker) {
			return true
		}
	}
	return false
}
