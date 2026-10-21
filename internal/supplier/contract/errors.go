// Package contract is the supplier portal's public types and sentinel errors.
package contract

import "errors"

// Level is the architecture level for supplier.
const Level = 3

var (
	// ErrNoTenant means neither an org id nor a supplier user id was supplied.
	ErrNoTenant = errors.New("missing tenant")
	// ErrUnavailable means the repository has no database begin function.
	ErrUnavailable = errors.New("database unavailable")
	// ErrNotPorted is the HTTP and asset-download stand-in. No request is sent.
	ErrNotPorted = errors.New("not_ported")
)

// MicrofenPerCent converts a cent amount to microfen:
// amount_microfen = amount_cents * 1000000.
const MicrofenPerCent int64 = 1_000_000
