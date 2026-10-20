package domain

import "fmt"

// Lease domains in status order.
var LeaseDomains = []string{"auth", "entitlement", "catalog", "recipe", "telemetry", "admin", "release"}

const (
	HolderAxum = "axum"
	HolderHono = "hono"
	leaseTTL   = int64(60_000)
)

// ParseLeaseDomain accepts the seven capability domains.
func ParseLeaseDomain(raw string) (string, bool) {
	switch raw {
	case "auth", "entitlement", "catalog", "recipe", "telemetry", "admin", "release":
		return raw, true
	default:
		return "", false
	}
}

// Lease is one writer_leases row.
type Lease struct {
	ID             int64
	Domain         string
	Holder         string
	HolderInstance string
	Fence          int64
	GrantedAt      int64
	ExpiresAt      int64
	HeartbeatAt    int64
	RevokedAt      *int64
	Reason         string
}

// Alive is inside the expiry and heartbeat window.
func (l Lease) Alive(now int64) bool {
	return l.RevokedAt == nil && l.ExpiresAt > now && l.HeartbeatAt+leaseTTL > now
}

// GrantDecision is what grant_with_audit does with the locked row.
type GrantDecision struct {
	Reuse       bool
	RevokeFirst bool
	Conflict    string
	Fence       string
}

// DecideGrant compares the live row with the request.
// actual is nil when no unrevoked row exists.
func DecideGrant(row *Lease, sameHolder bool, expected *int64, now int64, domain string) GrantDecision {
	var actual *int64
	if row != nil {
		token := row.Fence
		actual = &token
	}
	if !fenceEqual(expected, actual) {
		return GrantDecision{Fence: FenceMismatch(domain, expected, actual)}
	}
	if row != nil && row.Alive(now) && !sameHolder {
		return GrantDecision{Conflict: fmt.Sprintf("writer lease conflict for %s: active lease held by %s/%s is still heartbeating; revoke and drain first", domain, row.Holder, row.HolderInstance)}
	}
	if row != nil && row.Alive(now) && sameHolder {
		return GrantDecision{Reuse: true}
	}
	if row != nil {
		return GrantDecision{RevokeFirst: true}
	}
	return GrantDecision{}
}

// DecideRevoke handles a missing or mismatched fence.
func DecideRevoke(row *Lease, expected *int64, domain string) (skip bool, mismatch string) {
	var actual *int64
	if row != nil {
		token := row.Fence
		actual = &token
	}
	if row == nil {
		if expected != nil {
			return false, FenceMismatch(domain, expected, nil)
		}
		return true, ""
	}
	if expected != nil && *expected != row.Fence {
		return false, FenceMismatch(domain, expected, actual)
	}
	return false, ""
}

func fenceEqual(expected, actual *int64) bool {
	if expected == nil && actual == nil {
		return true
	}
	if expected == nil || actual == nil {
		return false
	}
	return *expected == *actual
}

// FenceMismatch is the Display string, with Rust Option debug.
func FenceMismatch(domain string, expected, actual *int64) string {
	return fmt.Sprintf("writer lease fence mismatch for %s: expected %s, actual %s", domain, optDebug(expected), optDebug(actual))
}

func optDebug(v *int64) string {
	if v == nil {
		return "None"
	}
	return fmt.Sprintf("Some(%d)", *v)
}

// GrantEvent is grant or grant_release.
func GrantEvent(holder string) string {
	if holder != HolderAxum {
		return "grant_release"
	}
	return "grant"
}

// AuthorityReleased is true when the holder is not axum.
func AuthorityReleased(holder string) bool { return holder != HolderAxum }
