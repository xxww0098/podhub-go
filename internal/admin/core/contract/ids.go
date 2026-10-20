package contract

import (
	"strconv"
	"strings"
)

// CanonicalUUID accepts a trimmed hyphenated or 32-hex UUID and returns
// the lowercase hyphenated form. Anything else is not an id.
func CanonicalUUID(raw string) (string, bool) {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = strings.TrimPrefix(s, "urn:uuid:")
	if len(s) >= 2 && s[0] == '{' && s[len(s)-1] == '}' {
		s = s[1 : len(s)-1]
	}
	hexDigits := strings.ReplaceAll(s, "-", "")
	if len(hexDigits) != 32 {
		return "", false
	}
	for _, c := range hexDigits {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return "", false
		}
	}
	return hexDigits[0:8] + "-" + hexDigits[8:12] + "-" + hexDigits[12:16] + "-" + hexDigits[16:20] + "-" + hexDigits[20:32], true
}

// Itoa64 formats n in base 10.
func Itoa64(n int64) string { return strconv.FormatInt(n, 10) }
