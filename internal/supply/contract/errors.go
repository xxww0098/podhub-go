// Package contract is the supply domain's public types and sentinel errors.
package contract

import "errors"

// Level is the architecture level for supply.
const Level = 3

var (
	// ErrUnproven means the status edge is not in the copied SQL functions.
	ErrUnproven = errors.New("supply transition is not proven")
	// ErrNotFound is an application miss. sc_listing_bindings has no RLS,
	// so the repository filters org_id itself.
	ErrNotFound = errors.New("not found")
	// ErrNoTenant means the caller did not pass an org id.
	ErrNoTenant = errors.New("missing tenant")
	// ErrUnavailable means the repository has no database begin function.
	ErrUnavailable = errors.New("database unavailable")
	// ErrNotPorted is the HTTP stand-in.
	ErrNotPorted = errors.New("not_ported")
)

// Binding is the sc_listing_bindings projection the repository can prove
// from columns. The seller JSON envelope is not proven.
type Binding struct {
	PlatformSKUID  string
	SpecVersion    int64
	DesignRevision int64
}
