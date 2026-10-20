package contract

import "testing"

func TestWorkspaceMatrix(t *testing.T) {
	if _, ok := ParseWorkspace("root"); ok {
		t.Fatal("unknown role parsed")
	}
	if CanManage("root") || CanManage("") || CanManage("member") || CanManage("viewer") {
		t.Fatal("manage cut")
	}
	if !CanManage("owner") || !CanManage(" manager ") || !CanManage("ADMIN") {
		t.Fatal("owner and manager")
	}
	for _, role := range []string{"owner", "manager", "member", "reviewer"} {
		if !AllowsListingPrepare(role) {
			t.Fatalf("%s should prepare", role)
		}
	}
	if AllowsListingPrepare("viewer") || AllowsListingPrepare("nope") {
		t.Fatal("viewer and unknown must not prepare")
	}
	for _, role := range []string{"owner", "manager", "admin", "member"} {
		if !AllowsListingSubmit(role) {
			t.Fatalf("%s should submit", role)
		}
	}
	if AllowsListingSubmit("reviewer") || AllowsListingSubmit("viewer") || AllowsListingSubmit("nope") {
		t.Fatal("reviewer, viewer, and unknown must not submit")
	}
	assigned := int64(7)
	other := int64(8)
	if !StoreVisible("owner", nil, 7) || !StoreVisible("ADMIN", nil, 7) {
		t.Fatal("managers see an unassigned store")
	}
	if StoreVisible("member", nil, 7) || !StoreVisible("member", &assigned, 7) || StoreVisible("member", &other, 7) {
		t.Fatal("operator visibility")
	}
	if StoreVisible("nope", &assigned, 7) || StoreVisible("reviewer", nil, 1) {
		t.Fatal("unknown sees nothing; reviewer sees only an assignment")
	}
	if !StoreVisible("reviewer", &assigned, 7) {
		t.Fatal("assigned reviewer")
	}
	if !IsSuperAdmin(" Super_Admin ") || IsSuperAdmin("admin") || IsSuperAdmin("superadmin") {
		t.Fatal("platform rank")
	}
}

func TestGates(t *testing.T) {
	_, msg, ok := ListingPrepare(Principal{OrgID: 0, WorkspaceRole: "owner"})
	if ok || msg != MsgNoWorkspace {
		t.Fatalf("no workspace: %v %s", ok, msg)
	}
	_, msg, ok = ListingPrepare(Principal{OrgID: 4, WorkspaceRole: " "})
	if ok || msg != MsgNoWorkspace {
		t.Fatalf("blank role: %v %s", ok, msg)
	}
	_, msg, ok = ListingPrepare(Principal{OrgID: 4, WorkspaceRole: "root"})
	if ok || msg != MsgBadWorkspaceRole {
		t.Fatalf("bad role: %v %s", ok, msg)
	}
	_, msg, ok = ListingPrepare(Principal{OrgID: 4, WorkspaceRole: "viewer"})
	if ok || msg != MsgListingForbidden {
		t.Fatalf("viewer: %v %s", ok, msg)
	}
	if _, _, ok := ListingPrepare(Principal{OrgID: 4, WorkspaceRole: "member"}); !ok {
		t.Fatal("member prepares")
	}
	_, msg, ok = ListingSubmit(Principal{OrgID: 4, WorkspaceRole: "reviewer"})
	if ok || msg != MsgListingForbidden {
		t.Fatalf("reviewer submit: %v %s", ok, msg)
	}
	if _, _, ok := ListingSubmit(Principal{OrgID: 4, WorkspaceRole: "member"}); !ok {
		t.Fatal("member submits")
	}
	_, msg, ok = ListingSubmit(Principal{OrgID: 0, WorkspaceRole: "owner"})
	if ok || msg != MsgNoWorkspace {
		t.Fatalf("submit workspace: %s", msg)
	}
	_, msg, ok = OrgMember(Principal{OrgID: 0})
	if ok || msg != MsgNoWorkspace {
		t.Fatal(msg)
	}
	if _, _, ok := OrgMember(Principal{OrgID: 4}); !ok {
		t.Fatal("member")
	}
	_, msg, ok = OrgManager(Principal{OrgID: 4, WorkspaceRole: "member"})
	if ok || msg != MsgManager {
		t.Fatalf("operator manage: %s", msg)
	}
	if _, _, ok := OrgManager(Principal{OrgID: 4, WorkspaceRole: "admin"}); !ok {
		t.Fatal("stored admin manages")
	}
	_, msg, ok = SuperAdmin(Principal{PlatformRole: "admin"})
	if ok || msg != MsgSuperAdmin {
		t.Fatal(msg)
	}
	if _, _, ok := SuperAdmin(Principal{PlatformRole: "super_admin"}); !ok {
		t.Fatal("super")
	}
}
