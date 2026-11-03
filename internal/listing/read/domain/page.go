package domain

import (
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// MaxCursorMicros is 2100-01-01T00:00:00Z. A later boundary is treated as no cursor.
const MaxCursorMicros int64 = 4_102_444_800_000_000

// PageFetch is the jobs/cards second clamp. The caller asks for limit+1 rows
// and that argument is clamped to 100, so limit=100 never yields a next cursor.
func PageFetch(limit int64) (page, fetch int64) {
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}
	fetch = limit + 1
	if fetch > 100 {
		fetch = 100
	}
	return limit, fetch
}

// ParseLimit defaults to 50. Non-integers are invalid. Values outside 1..100
// are clamped by PageFetch, matching the list SQL.
func ParseLimit(raw string, present bool) (int64, bool) {
	if !present {
		page, _ := PageFetch(50)
		return page, true
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, false
	}
	page, _ := PageFetch(n)
	return page, true
}

// ParseCursor returns micros and a canonical uuid. A bad cursor is no cursor.
func ParseCursor(raw string) (int64, string) {
	if raw == "" {
		return 0, ""
	}
	microsText, idText, ok := strings.Cut(raw, ":")
	if !ok {
		return 0, ""
	}
	id, ok := CanonicalUUID(idText)
	if !ok {
		return 0, ""
	}
	micros, err := strconv.ParseInt(microsText, 10, 64)
	if err != nil || micros < 0 || micros > MaxCursorMicros {
		return 0, ""
	}
	return micros, id
}

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

// FormatCursor is `micros:uuid`, the card and job page boundary.
func FormatCursor(micros int64, id string) string {
	return strconv.FormatInt(micros, 10) + ":" + id
}
