// Package uuidx holds the one strict uuid spelling the store and ops scopes
// accept: trimmed, lowercase, 36 characters, dashes at 8/13/18/23, hex elsewhere.
package uuidx

import "strings"

// StrictUUID is Scope::normalize_uuid: trim, lower, 36 chars, dashes, hex.
func StrictUUID(raw string) (string, bool) {
	raw = strings.ToLower(strings.TrimSpace(raw))
	if len(raw) != 36 {
		return "", false
	}
	for i := 0; i < len(raw); i++ {
		switch i {
		case 8, 13, 18, 23:
			if raw[i] != '-' {
				return "", false
			}
		default:
			c := raw[i]
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
				return "", false
			}
		}
	}
	return raw, true
}
