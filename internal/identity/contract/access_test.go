package contract

import (
	"net/http"
	"reflect"
	"testing"
)

func TestWorkspaceRoles(t *testing.T) {
	for _, raw := range []string{"owner", "manager", "member", " MANAGER "} {
		role, ok := ParseWorkspace(raw)
		if !ok || role == "" {
			t.Fatalf("valid role %q rejected", raw)
		}
	}
	assigned, other := int64(7), int64(8)
	for _, raw := range []string{"", "root", "admin", "operator", "reviewer", "viewer", "super_admin", "supplier"} {
		role, ok := ParseWorkspace(raw)
		if ok || role != "" || CanManage(raw) || StoreVisible(raw, &assigned, 7) {
			t.Fatalf("invalid role %q granted access", raw)
		}
	}
	if !CanManage("owner") || !CanManage(" manager ") || CanManage("member") {
		t.Fatal("only owners and managers manage workspaces")
	}
	if !StoreVisible("owner", nil, 7) || !StoreVisible("manager", &other, 7) {
		t.Fatal("managers see every store")
	}
	if StoreVisible("member", nil, 7) || !StoreVisible("member", &assigned, 7) || StoreVisible("member", &other, 7) {
		t.Fatal("members see only their assigned stores")
	}
}

func TestMembershipChanges(t *testing.T) {
	roles := []WorkspaceRole{WorkspaceOwner, WorkspaceManager, WorkspaceMember, "", "reviewer"}
	for _, actor := range roles {
		for _, target := range roles {
			invite := (actor == WorkspaceOwner && (target == WorkspaceManager || target == WorkspaceMember)) ||
				(actor == WorkspaceManager && target == WorkspaceMember)
			change := actor == WorkspaceOwner && (target == WorkspaceManager || target == WorkspaceMember)
			if actor.MayInvite(target) != invite {
				t.Fatalf("%s invite %s", actor, target)
			}
			for _, self := range []bool{false, true} {
				if actor.MayRemoveMember(target, self) != (invite && !self) || actor.MayChangeRole(target, self) != (change && !self) {
					t.Fatalf("%s change/remove %s self=%v", actor, target, self)
				}
				var assignable []string
				if change && !self {
					assignable = []string{"manager"}
					if target == WorkspaceManager {
						assignable = []string{"member"}
					}
				}
				if got := actor.AssignableRoles(target, self); !reflect.DeepEqual(got, assignable) {
					t.Fatalf("%s assign %s self=%v: %v, want %v", actor, target, self, got, assignable)
				}
			}
		}
	}
}

func TestGates(t *testing.T) {
	for _, tc := range []struct {
		org           int64
		role, message string
	}{
		{0, "owner", MsgNoWorkspace}, {-1, "owner", MsgNoWorkspace},
		{4, " ", MsgNoWorkspace}, {4, "admin", MsgBadWorkspaceRole},
		{4, "reviewer", MsgBadWorkspaceRole}, {4, "viewer", MsgBadWorkspaceRole},
		{4, "root", MsgBadWorkspaceRole},
	} {
		p := Principal{OrgID: tc.org, WorkspaceRole: tc.role, PlatformRole: "super_admin"}
		for _, gate := range []func(Principal) (int, string, bool){OrgMember, OrgManager} {
			status, msg, ok := gate(p)
			if ok || status != http.StatusForbidden || msg != tc.message {
				t.Fatalf("%+v: %d %q %v", tc, status, msg, ok)
			}
		}
	}
	for _, role := range []string{"owner", "manager", "member"} {
		p := Principal{OrgID: 4, WorkspaceRole: role}
		if _, _, ok := OrgMember(p); !ok {
			t.Fatalf("%s is a member", role)
		}
		status, msg, ok := OrgManager(p)
		if ok != (role != "member") || (!ok && (status != http.StatusForbidden || msg != MsgManager)) {
			t.Fatalf("manager %s: %d %q %v", role, status, msg, ok)
		}
	}
	if _, msg, ok := SuperAdmin(Principal{PlatformRole: "admin"}); ok || msg != MsgSuperAdmin {
		t.Fatal("admin is not super")
	}
	if _, _, ok := SuperAdmin(Principal{PlatformRole: "super_admin"}); !ok {
		t.Fatal("super")
	}
}

func TestPlatformRoles(t *testing.T) {
	for _, tc := range []struct {
		role         string
		staff, super bool
	}{
		{"super_admin", true, true}, {" Super_Admin ", true, true},
		{"admin", true, false}, {" ADMIN ", true, false},
		{"user", false, false}, {"owner", false, false}, {"manager", false, false},
		{"member", false, false}, {"supplier", false, false}, {"superadmin", false, false}, {"", false, false},
	} {
		if IsPlatformStaff(tc.role) != tc.staff || IsSuperAdmin(tc.role) != tc.super {
			t.Fatalf("%+v", tc)
		}
	}
}
