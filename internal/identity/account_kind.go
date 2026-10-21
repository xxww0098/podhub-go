package identity

import "strings"

// AccountKind is the stored account_users.account_kind vocabulary (doc §3.1).
// It is the single source of truth for which surface an account belongs to;
// the login response's "target" is a landing-page hint only, never an
// authorization signal.
type AccountKind string

const (
	// AccountKindPlatform is every staff and every ordinary workspace user.
	AccountKindPlatform AccountKind = "platform"
	// AccountKindSupplier is a supplier portal account. It is always role=user
	// (enforced by ck_account_users_supplier_is_user) and never joins a
	// Workspace.
	AccountKindSupplier AccountKind = "supplier"
)

// AccountKindFromStored normalizes one stored value. The column is NOT NULL
// DEFAULT 'platform' with a CHECK over the two literals, so anything else is a
// read artefact (a fixture built before the column existed, a hand-edited
// row). Those fall back to platform, and the surface decision still does not
// trust this value alone: every supplier route also demands a live supplier
// grant.
func AccountKindFromStored(raw string) string {
	if strings.EqualFold(strings.TrimSpace(raw), string(AccountKindSupplier)) {
		return string(AccountKindSupplier)
	}
	return string(AccountKindPlatform)
}

// IsSupplierAccount reports whether a stored account_kind is the supplier one.
func IsSupplierAccount(raw string) bool {
	return AccountKindFromStored(raw) == string(AccountKindSupplier)
}
