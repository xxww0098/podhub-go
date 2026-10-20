package domain

import (
	"strings"

	"github.com/xxww0098/podhub-go/internal/ops/contract"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

// RequireStoreRead is require_tenant plus Capability::StoreRead.
// Every parsed workspace role may read. Unknown roles do not become viewer.
func RequireStoreRead(orgID int64, role string) *contract.Fail {
	if f := tenant(orgID, role); f != nil {
		return f
	}
	return nil
}

// RequireSubmit is admit_write's capability: owner, manager, operator.
func RequireSubmit(orgID int64, role string) *contract.Fail {
	if f := tenant(orgID, role); f != nil {
		return f
	}
	parsed, _ := access.ParseWorkspace(role)
	if parsed != "owner" && parsed != "manager" && parsed != "operator" {
		return contract.Forbidden(contract.MsgNoWriteRole)
	}
	return nil
}

// RequireReconcile runs after StoreRead. Viewer cannot reconcile.
func RequireReconcile(orgID int64, role string) *contract.Fail {
	if f := RequireStoreRead(orgID, role); f != nil {
		return f
	}
	parsed, _ := access.ParseWorkspace(role)
	if parsed == "viewer" {
		return contract.Forbidden(contract.MsgNoReconcileRole)
	}
	return nil
}

func tenant(orgID int64, role string) *contract.Fail {
	if orgID <= 0 || strings.TrimSpace(role) == "" {
		return contract.Forbidden(access.MsgNoWorkspace)
	}
	if _, ok := access.ParseWorkspace(role); !ok {
		return contract.Forbidden(access.MsgBadWorkspaceRole)
	}
	return nil
}
