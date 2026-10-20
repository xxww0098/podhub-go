package domain

import (
	"strings"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
)

// NewPublicID is a hyphenated UUID string (new_public_id).
func NewPublicID() (string, error) { return corecontract.NewPublicID() }

// MintID is prefix plus the UUID hex with hyphens removed.
func MintID(prefix string) (string, error) {
	id, err := NewPublicID()
	if err != nil {
		return "", err
	}
	return prefix + "_" + strings.ReplaceAll(id, "-", ""), nil
}

// CanonicalUUID accepts a trimmed hyphenated or 32-hex UUID and returns
// the lowercase hyphenated form. Anything else is not an id.
func CanonicalUUID(raw string) (string, bool) { return corecontract.CanonicalUUID(raw) }
