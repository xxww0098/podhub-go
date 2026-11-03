package domain

import (
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

// RequireWorkspace checks membership before store-level authorization.
func RequireWorkspace(orgID int64, role string) *contract.Fail {
	if _, message, ok := access.OrgMember(access.Principal{OrgID: orgID, WorkspaceRole: role}); !ok {
		return contract.Forbidden(message)
	}
	return nil
}
