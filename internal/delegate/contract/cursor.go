package contract

import (
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// NormalizeUUID is Uuid::parse_str + to_string. Failure is the caller's 404.
func NormalizeUUID(raw string) (string, bool) {
	id, err := uuid.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", false
	}
	return id.String(), true
}

// Cursor is created_at_ms:order_id. The order id is the first cut's remainder.
func EncodeCursor(createdAtMS int64, orderID string) string {
	return strconv.FormatInt(createdAtMS, 10) + ":" + orderID
}

// DecodeCursor rejects a missing colon, a non-integer prefix, or a bad uuid.
func DecodeCursor(raw string) (int64, string, bool) {
	msRaw, id, ok := strings.Cut(raw, ":")
	if !ok || msRaw == "" || id == "" {
		return 0, "", false
	}
	ms, err := strconv.ParseInt(msRaw, 10, 64)
	if err != nil {
		return 0, "", false
	}
	parsed, ok := NormalizeUUID(id)
	if !ok {
		return 0, "", false
	}
	return ms, parsed, true
}
