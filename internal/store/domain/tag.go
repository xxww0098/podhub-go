package domain

import (
	"strings"

	"github.com/xxww0098/podhub-go/internal/store/contract"
)

// Tag is one Workspace Store tag: a label an org's members put on stores.
// uuid is the lower-case text form of organization_store_tags.uuid.
type Tag struct {
	UUID       string
	Name       string
	StoreCount int64
}

// TagDeleted is the DELETE response body's data.
type TagDeleted struct {
	UUID    string
	Deleted bool
}

// MaxTagName is the character ceiling for a tag name. It counts characters,
// not bytes, matching the Rust normalizer.
const MaxTagName = 64

// ValidTagName trims and checks one tag name. An empty name and a name over
// MaxTagName runes are both invalid; the message says which.
func ValidTagName(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", contract.ErrTagName
	}
	if len([]rune(trimmed)) > MaxTagName {
		return "", contract.ErrTagNameLength
	}
	return trimmed, nil
}
