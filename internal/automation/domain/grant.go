package domain

import "github.com/xxww0098/podhub-go/internal/automation/contract"

// Grant scopes and actions are the CHECK constraints added by
// db/migrations/00263_automation_grant_scopes.sql.
const (
	ScopeWorkspace       = "workspace"
	ScopeCatalog         = "catalog"
	ScopeSupplierCatalog = "supplier_catalog"
)

// Grant is the authority shape the CHECK accepts. SourceIDs nil means SQL NULL.
type Grant struct {
	Scope     string
	OrgID     int64
	Actions   []string
	SourceIDs []string
}

// Valid reports whether the row would pass automation_grants_scope_shape,
// automation_grants_actions_known, and automation_grants_source_ids_shape.
// Duplicate actions are allowed: PostgreSQL `<@` does not require distinct elements.
func (g Grant) Valid() error {
	if len(g.Actions) == 0 {
		return contract.ErrIllegalAction
	}
	if g.SourceIDs != nil && len(g.SourceIDs) > 200 {
		return contract.ErrIllegalScope
	}
	switch g.Scope {
	case ScopeWorkspace:
		if g.OrgID <= 0 || g.SourceIDs != nil {
			return contract.ErrIllegalScope
		}
		return subset(g.Actions, "read", "prepare", "submit", "catalog:read", "cards:write")
	case ScopeCatalog:
		if g.OrgID != 0 || g.SourceIDs != nil {
			return contract.ErrIllegalScope
		}
		return subset(g.Actions, "catalog:read")
	case ScopeSupplierCatalog:
		if g.OrgID != 0 {
			return contract.ErrIllegalScope
		}
		return subset(g.Actions, "supplier:read", "supplier:write", "supplier:delete", "supplier:publish", "supplier:price")
	default:
		return contract.ErrIllegalScope
	}
}

func subset(actions []string, allowed ...string) error {
	ok := map[string]struct{}{}
	for _, action := range allowed {
		ok[action] = struct{}{}
	}
	for _, action := range actions {
		if _, allowed := ok[action]; !allowed {
			return contract.ErrIllegalAction
		}
	}
	return nil
}
