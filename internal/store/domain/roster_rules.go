package domain

import (
	"strings"

	"github.com/xxww0098/podhub-go/internal/store/contract"
)

const (
	// MaxStoreName is the character ceiling for a Store display name.
	MaxStoreName = 255
	// MaxClientID is the character ceiling for an Ozon Client ID.
	MaxClientID = 128
	// MaxStoreTagName is the character ceiling for a tag name.
	MaxStoreTagName = 64
	// MaxStoreGroupName is the character ceiling for a group name.
	MaxStoreGroupName = 64
)

// NormalizeStoreName trims and checks a Store display name. The ceiling counts
// characters, not bytes.
func NormalizeStoreName(value string) (string, *contract.APIError) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", contract.Validation(contract.MsgStoreNameEmpty)
	}
	if len([]rune(trimmed)) > MaxStoreName {
		return "", contract.Validation(contract.MsgStoreNameLong)
	}
	return trimmed, nil
}

// NormalizeClientID trims a Client ID. An empty result is "no Client ID" and
// is not an error. The value keeps its case.
func NormalizeClientID(value *string) (*string, *contract.APIError) {
	if value == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil, nil
	}
	if len([]rune(trimmed)) > MaxClientID {
		return nil, contract.Validation(contract.MsgClientIDLong)
	}
	return &trimmed, nil
}

// NormalizeStoreTagName trims and checks a tag name.
func NormalizeStoreTagName(value string) (string, *contract.APIError) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", contract.Validation(contract.MsgTagNameEmpty)
	}
	if len([]rune(trimmed)) > MaxStoreTagName {
		return "", contract.Validation(contract.MsgTagNameLong)
	}
	return trimmed, nil
}

// NormalizeStoreGroupName trims and checks a group name.
func NormalizeStoreGroupName(value string) (string, *contract.APIError) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", contract.Validation(contract.MsgGroupNameEmpty)
	}
	if len([]rune(trimmed)) > MaxStoreGroupName {
		return "", contract.Validation(contract.MsgGroupNameLong)
	}
	return trimmed, nil
}

// NormalizeStoreUUID is auth::normalize_uuid: trim, lower-case, 36 characters,
// a dash at every 8th position. Anything else has no store.
func NormalizeStoreUUID(value string) (string, bool) {
	lowered := strings.ToLower(strings.TrimSpace(value))
	if len(lowered) != 36 {
		return "", false
	}
	for i := 0; i < len(lowered); i++ {
		b := lowered[i]
		switch i {
		case 8, 13, 18, 23:
			if b != '-' {
				return "", false
			}
		default:
			if !isHex(b) {
				return "", false
			}
		}
	}
	return lowered, true
}

func isHex(b byte) bool {
	switch {
	case b >= '0' && b <= '9':
		return true
	case b >= 'a' && b <= 'f':
		return true
	case b >= 'A' && b <= 'F':
		return true
	}
	return false
}

// AssigneeForCreate is assignee_for_create. An owner gets exactly what they
// asked for. A manager may name any workspacemate and otherwise lands on
// themselves so they can register the first key. A member may only name
// themselves.
func AssigneeForCreate(actor Actor, requested *int64) (*int64, *contract.APIError) {
	if actor.IsOwner() {
		return requested, nil
	}
	if !actor.CanManageAll() && requested != nil && *requested != actor.MembershipID {
		return nil, contract.Forbidden(contract.MsgAssigneeOther)
	}
	if requested != nil {
		return requested, nil
	}
	self := actor.MembershipID
	return &self, nil
}

// MayDeleteStore is ensure_may_delete_store. A store that holds ciphertext
// requires the key grant; one that does not is open to a manager or its
// assignee. Everything else looks like "no such store".
func MayDeleteStore(actor Actor, row Row) *contract.APIError {
	if !actor.Visible(row.AssigneeMembershipID) {
		return contract.NotFound(contract.MsgStoreMissing)
	}
	if row.CredentialAnyConfigured {
		if actor.MayManageKey(row.AssigneeKeyManage, row.AssigneeMembershipID) {
			return nil
		}
		return contract.Forbidden(contract.MsgNoKeyPermission)
	}
	if actor.CanManageAll() || actor.IsAssigneeOf(row.AssigneeMembershipID) {
		return nil
	}
	return contract.NotFound(contract.MsgStoreMissing)
}

// EnsureRevision is projection::ensure_revision.
func EnsureRevision(row Row, expected int64) *contract.APIError {
	if expected < 1 || row.Revision != expected {
		return contract.Conflict(contract.MsgRevisionStale)
	}
	return nil
}

// EnsureCredentialRevision is credential_store::ensure_revision, which uses its
// own copy of the "someone else changed it" message.
func EnsureCredentialRevision(actual, expected int64) *contract.APIError {
	if expected < 1 || actual != expected {
		return contract.Conflict(contract.MsgStoreUpdatedElse)
	}
	return nil
}

// ConflictByIndex maps a unique-index violation to the caller-facing refusal.
// The index name is the only reliable discriminator; anything else is a server
// fault, not something the caller did.
func ConflictByIndex(indexName string) *contract.APIError {
	switch indexName {
	case "uq_organization_store_tags_name":
		return contract.Conflict(contract.MsgSameTagName)
	case "uq_organization_store_groups_name":
		return contract.Conflict(contract.MsgSameGroupName)
	case "uq_organization_stores_live_client_id":
		return contract.Conflict(contract.MsgClientIDDuplicate)
	}
	return nil
}
