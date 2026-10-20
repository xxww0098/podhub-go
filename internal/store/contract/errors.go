// Package contract is the store company's public errors.
package contract

import "errors"

var (
	// ErrNotFound is a missing or deleted store inside the caller's org.
	ErrNotFound = errors.New("store not found")
	// ErrNoTenant is a missing org id or a transaction without the tenant GUC.
	ErrNoTenant = errors.New("tenant org is unset")
	// ErrUnavailable is a missing pool or opener.
	ErrUnavailable = errors.New("store directory unavailable")
	// ErrForbidden is a role that cannot rename a store.
	ErrForbidden = errors.New("store rename forbidden")
	// ErrName is an empty store name.
	ErrName = errors.New("store name is empty")
	// ErrNameLength is a store name longer than the column.
	ErrNameLength = errors.New("store name is too long")
	// ErrNoCredential means the store has no sealed seller key to open.
	ErrNoCredential = errors.New("store credential is missing")
	// ErrTagName is an empty or whitespace-only tag name.
	ErrTagName = errors.New("tag name is empty")
	// ErrTagNameLength is a tag name over 64 characters.
	ErrTagNameLength = errors.New("tag name is too long")
	// ErrTagUUID is a path uuid that is not a UUID.
	ErrTagUUID = errors.New("tag uuid is invalid")
	// ErrTagExists is a duplicate name inside one org.
	ErrTagExists = errors.New("tag name already exists")
	// ErrTagNotFound is a missing tag inside the caller's org.
	ErrTagNotFound = errors.New("tag not found")
)
