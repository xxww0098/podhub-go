package domain

import "strings"

const (
	grantDefaultTTL = 60
	grantMaxTTL     = 1440
)

// GrantRequest is a validated issue body.
type GrantRequest struct {
	OrgID       int64
	StaffUserID int64
	Reason      string
	TTLMinutes  int64
}

// ValidateGrant checks the four issue rules. Zero staff means the actor.
func ValidateGrant(orgID, staff int64, reason string, ttl *int64, actorID int64) (GrantRequest, string) {
	if orgID <= 0 {
		return GrantRequest{}, "org_id 无效"
	}
	if staff == 0 {
		staff = actorID
	}
	if staff <= 0 {
		return GrantRequest{}, "平台人员无效"
	}
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return GrantRequest{}, "签发原因不能为空"
	}
	minutes := int64(grantDefaultTTL)
	if ttl != nil {
		minutes = *ttl
	}
	if minutes < 1 || minutes > grantMaxTTL {
		return GrantRequest{}, "ttl_minutes 需在 1-1440 之间"
	}
	return GrantRequest{OrgID: orgID, StaffUserID: staff, Reason: reason, TTLMinutes: minutes}, ""
}

// DissolveName checks the confirmation string.
func DissolveName(name string) bool {
	name = strings.TrimSpace(name)
	return name != "" && len([]rune(name)) <= 64
}

// DissolveUUID checks the path token before SQL.
func DissolveUUID(raw string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 36 {
		return false
	}
	return parseUUID(raw)
}

func parseUUID(raw string) bool {
	// 8-4-4-4-12 hex. Version nibble is not required by uuid::Uuid::parse_str
	// beyond the canonical shape; accept any hex in those groups.
	parts := []int{8, 4, 4, 4, 12}
	i := 0
	for n, size := range parts {
		if n > 0 {
			if i >= len(raw) || raw[i] != '-' {
				return false
			}
			i++
		}
		for k := 0; k < size; k++ {
			if i >= len(raw) || !isHex(raw[i]) {
				return false
			}
			i++
		}
	}
	return i == len(raw)
}

func isHex(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f') || (b >= 'A' && b <= 'F')
}
