package domain

import (
	"errors"
	"testing"

	"github.com/xxww0098/podhub-go/internal/automation/contract"
)

func TestGrantCheck(t *testing.T) {
	long := make([]string, 201)
	cases := []struct {
		name string
		g    Grant
		err  error
	}{
		{name: "workspace read", g: Grant{Scope: ScopeWorkspace, OrgID: 1, Actions: []string{"read"}}},
		{name: "workspace duplicate", g: Grant{Scope: ScopeWorkspace, OrgID: 1, Actions: []string{"read", "read", "prepare"}}},
		{name: "workspace all", g: Grant{Scope: ScopeWorkspace, OrgID: 4, Actions: []string{"read", "prepare", "submit", "catalog:read", "cards:write"}}},
		{name: "catalog", g: Grant{Scope: ScopeCatalog, Actions: []string{"catalog:read"}}},
		{name: "supplier empty sources", g: Grant{Scope: ScopeSupplierCatalog, Actions: []string{"supplier:publish"}, SourceIDs: []string{}}},
		{name: "supplier sources", g: Grant{Scope: ScopeSupplierCatalog, Actions: []string{"supplier:read", "supplier:price"}, SourceIDs: []string{"a"}}},
		{name: "empty actions", g: Grant{Scope: ScopeWorkspace, OrgID: 1}, err: contract.ErrIllegalAction},
		{name: "workspace submit only on catalog", g: Grant{Scope: ScopeCatalog, Actions: []string{"submit"}}, err: contract.ErrIllegalAction},
		{name: "workspace without org", g: Grant{Scope: ScopeWorkspace, Actions: []string{"read"}}, err: contract.ErrIllegalScope},
		{name: "workspace with sources", g: Grant{Scope: ScopeWorkspace, OrgID: 1, Actions: []string{"read"}, SourceIDs: []string{"a"}}, err: contract.ErrIllegalScope},
		{name: "catalog with org", g: Grant{Scope: ScopeCatalog, OrgID: 1, Actions: []string{"catalog:read"}}, err: contract.ErrIllegalScope},
		{name: "supplier with org", g: Grant{Scope: ScopeSupplierCatalog, OrgID: 1, Actions: []string{"supplier:read"}}, err: contract.ErrIllegalScope},
		{name: "unknown scope", g: Grant{Scope: "global", Actions: []string{"read"}}, err: contract.ErrIllegalScope},
		{name: "too many sources", g: Grant{Scope: ScopeSupplierCatalog, Actions: []string{"supplier:read"}, SourceIDs: long}, err: contract.ErrIllegalScope},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.g.Valid()
			if tc.err == nil && err != nil {
				t.Fatal(err)
			}
			if tc.err != nil && !errors.Is(err, tc.err) {
				t.Fatalf("got %v", err)
			}
		})
	}
}
