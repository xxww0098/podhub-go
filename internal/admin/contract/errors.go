// Package contract is the admin surface. The domain level is L6.
// Global banned-tag routes stay on internal/platform and are not repeated here.
package contract

import "errors"

// ErrNotPorted is the mounted handler body.
var ErrNotPorted = errors.New("not_ported")

// ErrStaffDenied is the fail-closed body for a platform-staff route.
// The Rust sentence for this refusal was not readable.
var ErrStaffDenied = errors.New("forbidden")
