package domain

import "testing"

func TestWorkspaceGrantRoles(t *testing.T) {
	actions := []string{"read", "catalog:read", "prepare", "cards:write", "submit"}
	for _, tc := range []struct {
		role    string
		allowed bool
	}{
		{"owner", true}, {"manager", true}, {"member", true},
		{"", false}, {"admin", false}, {"super_admin", false}, {"operator", false},
		{"reviewer", false}, {"viewer", false}, {"unknown", false},
	} {
		grant := Grant{ScopeKind: "workspace", WorkspaceRole: tc.role, Actions: actions}
		for _, action := range actions {
			if grant.Permits(action) != tc.allowed {
				t.Fatalf("%q permits %s", tc.role, action)
			}
		}
		if grant.Permits("supplier:write") {
			t.Fatal("workspace grant may not write supplier catalog")
		}
	}
	grant := Grant{ScopeKind: "workspace", WorkspaceRole: "owner", Actions: []string{"read"}}
	if grant.Permits("submit") {
		t.Fatal("role does not add ungranted actions")
	}
	catalog := Grant{ScopeKind: "catalog", Actions: []string{"catalog:read", "submit"}}
	if !catalog.Permits("catalog:read") || catalog.Permits("submit") {
		t.Fatal("public catalog scope")
	}
}
