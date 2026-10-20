package domain

import "testing"

func TestLeaseDecisions(t *testing.T) {
	now := int64(1_000_000)
	live := &Lease{Holder: "axum", HolderInstance: "a", Fence: 3, ExpiresAt: now + 10, HeartbeatAt: now}
	exp := int64(3)
	if d := DecideGrant(live, true, &exp, now, "admin"); !d.Reuse || d.Conflict != "" || d.Fence != "" {
		t.Fatalf("%+v", d)
	}
	if d := DecideGrant(live, false, &exp, now, "admin"); d.Conflict == "" {
		t.Fatal("conflict")
	}
	bad := int64(9)
	if d := DecideGrant(live, true, &bad, now, "catalog"); d.Fence != "writer lease fence mismatch for catalog: expected Some(9), actual Some(3)" {
		t.Fatal(d.Fence)
	}
	if d := DecideGrant(nil, false, nil, now, "auth"); d.Reuse || d.RevokeFirst || d.Fence != "" {
		t.Fatalf("%+v", d)
	}
	if d := DecideGrant(nil, false, &exp, now, "auth"); d.Fence != "writer lease fence mismatch for auth: expected Some(3), actual None" {
		t.Fatal(d.Fence)
	}
	stale := &Lease{Holder: "hono", HolderInstance: "b", Fence: 3, ExpiresAt: now - 1, HeartbeatAt: now - 1}
	if d := DecideGrant(stale, false, &exp, now, "auth"); !d.RevokeFirst {
		t.Fatalf("%+v", d)
	}
	skip, msg := DecideRevoke(nil, nil, "admin")
	if !skip || msg != "" {
		t.Fatal(skip, msg)
	}
	skip, msg = DecideRevoke(nil, &exp, "admin")
	if skip || msg == "" {
		t.Fatal(msg)
	}
	if GrantEvent("hono") != "grant_release" || GrantEvent("axum") != "grant" || !AuthorityReleased("hono") || AuthorityReleased("axum") {
		t.Fatal("event")
	}
	if _, ok := ParseLeaseDomain(" billing "); ok {
		t.Fatal("parse")
	}
	if len(LeaseDomains) != 7 || LeaseDomains[0] != "auth" || LeaseDomains[6] != "release" {
		t.Fatal(LeaseDomains)
	}
}
