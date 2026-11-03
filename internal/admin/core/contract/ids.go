package contract

import (
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// CanonicalUUID parses a uuid in any of google/uuid's accepted spellings
// (hyphenated, 32-hex, braced, urn-prefixed) and returns the lowercase
// hyphenated form. Anything else is not an id.
func CanonicalUUID(raw string) (string, bool) {
	id, err := uuid.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", false
	}
	return id.String(), true
}

// Itoa64 formats n in base 10.
func Itoa64(n int64) string { return strconv.FormatInt(n, 10) }
