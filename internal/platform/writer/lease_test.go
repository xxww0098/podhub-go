package writer

import "testing"

// legacyKind is the check that used to live in that domain, before Assert.
type legacyKind int

const (
	// any live row, or any historical row, refuses. A matching holder does not help.
	// Used by agent auth, telemetry, supplier portal (on entitlement), and supply orders.
	legacyAnyLiveOrEver legacyKind = iota
	// any historical admin row refuses, including a live row this process holds.
	legacyAnyHistory
	// no rows allow; any unrevoked row refuses, even when it matches and is live.
	// A revoked-only history still allows. Used by delegate guardLease and admit
	// before the holder check (admit also refused a matching live row).
	legacyAnyUnrevoked
	// count of admin rows is zero → allow. Any row with expires_at_ms > now → allow,
	// ignoring holder, instance, and heartbeat. Otherwise refuse.
	legacyCountExpires
	// the instance string is hostname:pid (or the fixed "podhub-go"), so a
	// CLOUD_INSTANCE_ID lease does not match.
	legacyForeignInstance
)

func legacyAllow(kind legacyKind, row Active, nowMS int64, foreignInstance string) bool {
	switch kind {
	case legacyAnyLiveOrEver:
		if row.Present || row.Ever {
			return false
		}
		return true
	case legacyAnyHistory:
		return !row.Ever
	case legacyAnyUnrevoked:
		return !row.Present
	case legacyCountExpires:
		if !row.Ever {
			return true
		}
		return row.Present && row.ExpiresAt > nowMS
	case legacyForeignInstance:
		if !row.Present {
			return !row.Ever
		}
		if row.ExpiresAt <= nowMS || row.HeartbeatAt+LeaseTTLMS <= nowMS {
			return false
		}
		return row.Holder == HolderAxum && row.Instance == foreignInstance
	default:
		return false
	}
}

func TestDecideMatchesRustNotTheOldChecks(t *testing.T) {
	const now int64 = 1_700_000_000_000
	ours := Identity{Holder: HolderAxum, InstanceID: "axum-42"}
	live := Active{
		Present: true, Ever: true, ID: 9, Holder: HolderAxum, Instance: "axum-42",
		Fence: 3, ExpiresAt: now + 1000, HeartbeatAt: now - 1000,
	}
	expired := live
	expired.ExpiresAt = now
	staleBeat := live
	staleBeat.HeartbeatAt = now - LeaseTTLMS
	foreign := live
	foreign.Instance = "host:99"
	revokedOnly := Active{Ever: true}
	never := Active{}

	cases := []struct {
		name    string
		domain  string
		kind    legacyKind
		foreign string
		row     Active
		old     bool
		rust    bool
		beat    bool
	}{
		{"supplier portal matching admin lease", "admin", legacyAnyLiveOrEver, "", live, false, true, true},
		{"supplier portal foreign admin lease", "admin", legacyAnyLiveOrEver, "", foreign, false, false, false},
		{"supplier portal revoked admin history", "admin", legacyAnyLiveOrEver, "", revokedOnly, false, false, false},
		// Rust X3-B allowed this row. S1 refuses it. The old predicate still allows.
		{"supplier portal never leased", "admin", legacyAnyLiveOrEver, "", never, true, false, false},
		{"platform catalog any live expires", "admin", legacyCountExpires, "", foreign, true, false, false},
		{"platform catalog matching live", "admin", legacyCountExpires, "", live, true, true, true},
		{"platform catalog expired still counted", "admin", legacyCountExpires, "", expired, false, false, false},
		{"field pack hostname instance", "admin", legacyForeignInstance, "host:1", live, false, true, true},
		{"field pack cloud instance matches", "admin", legacyForeignInstance, "host:1", live, false, true, true},
		{"prompt video podhub-go instance", "admin", legacyForeignInstance, "podhub-go", live, false, true, true},
		{"agent auth matching", "auth", legacyAnyLiveOrEver, "", live, false, true, true},
		{"agent auth any live", "auth", legacyAnyLiveOrEver, "", foreign, false, false, false},
		{"agent auth revoked history", "auth", legacyAnyLiveOrEver, "", revokedOnly, false, false, false},
		{"delegate any unrevoked", "entitlement", legacyAnyUnrevoked, "", live, false, true, true},
		{"delegate ignores revoked history", "entitlement", legacyAnyUnrevoked, "", revokedOnly, true, false, false},
		{"telemetry any history", "telemetry", legacyAnyLiveOrEver, "", revokedOnly, false, false, false},
		{"telemetry matching", "telemetry", legacyAnyLiveOrEver, "", live, false, true, true},
		{"supply orders matching entitlement", "entitlement", legacyAnyLiveOrEver, "", live, false, true, true},
		{"admit refuses a live row it holds", "admin", legacyAnyUnrevoked, "", live, false, true, true},
		{"assertWrite any admin history", "admin", legacyAnyHistory, "", live, false, true, true},
		{"assertWrite revoked-only", "admin", legacyAnyHistory, "", revokedOnly, false, false, false},
		{"heartbeat window dead", "admin", legacyCountExpires, "", staleBeat, true, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			old := legacyAllow(tc.kind, tc.row, now, tc.foreign)
			if old != tc.old {
				t.Fatalf("old predicate %v, want %v", old, tc.old)
			}
			held, allow := Decide(tc.row, ours, now)
			if allow != tc.rust {
				t.Fatalf("rust allow %v, Decide %v", tc.rust, allow)
			}
			if allow && tc.beat {
				if held.ID == nil || *held.ID != tc.row.ID || held.Fence == nil || *held.Fence != tc.row.Fence {
					t.Fatalf("held %+v", held)
				}
			}
			if allow && !tc.beat && (held.ID != nil || held.Fence != nil) {
				t.Fatalf("unleased write stamped %+v", held)
			}
			if !allow && (held.ID != nil || held.Fence != nil) {
				t.Fatalf("refused write stamped %+v", held)
			}
			// The old predicate and Rust disagree on the rows this task exists to fix.
			// A case that still agrees is recorded so the table stays honest.
			_ = old
			if tc.name == "supplier portal matching admin lease" && old {
				t.Fatal("old supplier check allowed a live lease; it refused every live row")
			}
			if tc.name == "platform catalog any live expires" && !old {
				t.Fatal("old catalog check refused a foreign unexpired row; it allowed any expires_at_ms > now")
			}
			if tc.name == "delegate ignores revoked history" && !old {
				t.Fatal("old delegate check refused revoked history; it allowed when no unrevoked row existed")
			}
			if tc.name == "agent auth matching" && old {
				t.Fatal("old auth check allowed a live lease")
			}
			if tc.name == "field pack hostname instance" && old {
				t.Fatal("hostname:pid matched CLOUD_INSTANCE_ID axum-42")
			}
		})
	}
}

func TestDecideEmptyDomainRefuses(t *testing.T) {
	never := Active{}
	revokedOnly := Active{Ever: true}
	id := Identity{Holder: HolderAxum, InstanceID: "axum-1"}
	for _, row := range []Active{never, revokedOnly} {
		held, allow := Decide(row, id, 1)
		if allow || held.ID != nil || held.Fence != nil {
			t.Fatalf("row %+v allowed %+v", row, held)
		}
	}
}

func TestDecideClockBeforeEpochIsZero(t *testing.T) {
	row := Active{Present: true, Ever: true, ID: 1, Holder: HolderAxum, Instance: "axum-1", Fence: 1, ExpiresAt: 0, HeartbeatAt: 0}
	_, allow := Decide(row, Identity{Holder: HolderAxum, InstanceID: "axum-1"}, -1)
	if allow {
		t.Fatal("expires_at_ms 0 is not after the clamped now")
	}
}
