package domain

import (
	"fmt"
	"net/http"
	"testing"
)

func TestStoreCredentialPermissionsFollowWorkspaceRole(t *testing.T) {
	memberID := int64(3)
	row := Row{AssigneeMembershipID: &memberID, CredentialConfigured: true, CredentialAnyConfigured: true}
	for _, tc := range []struct {
		role       string
		membership int64
		manage     bool
	}{
		{"owner", 1, true},
		{"manager", 2, true},
		{"member", 3, false},
		{"member", 4, false},
	} {
		t.Run(fmt.Sprintf("%s-%d", tc.role, tc.membership), func(t *testing.T) {
			actor := Actor{Role: tc.role, MembershipID: tc.membership}
			perms := row.Permissions(actor, 0)
			if perms.ManageKey != tc.manage || perms.ManageStore != tc.manage || perms.DeleteStore != tc.manage {
				t.Fatalf("permissions=%+v", perms)
			}
			err := EnsureCanManageKey(actor, row)
			if tc.manage && err != nil {
				t.Fatal(err)
			}
			if !tc.manage && (err == nil || (tc.membership == memberID && err.Status != http.StatusForbidden) || (tc.membership != memberID && err.Status != http.StatusNotFound)) {
				t.Fatalf("member error=%v", err)
			}
			_, err = AssigneeForCreate(actor, nil)
			if (err == nil) != tc.manage {
				t.Fatalf("create error=%v", err)
			}
		})
	}
}
