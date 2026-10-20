// Package outcome is the supplier-admin failure and caller. It lives below
// admin and admin/x1 because both return it and errors.As must match one type.
// The admin/contract names are aliases of these.
package outcome

import "errors"

// Failure kinds. HTTP maps them onto each route family's code spelling.
const (
	KindValidation     = "validation"
	KindNotFound       = "not_found"
	KindConflict       = "conflict"
	KindForbidden      = "forbidden"
	KindWritesDisabled = "writes_disabled"
	KindInternal       = "internal"
	KindUnavailable    = "unavailable"
)

// Fail is a supplier-admin outcome. Message is the Rust sentence.
// Status overrides the kind's usual HTTP status when it is not zero
// (lock timeout is 503 with an internal code; media recycle is 409).
type Fail struct {
	Kind       string
	Message    string
	RetryAfter int
	Status     int
	// Code overrides the family's spelled code when set (STORAGE_NOT_CONFIGURED, UPLOAD_OBJECT_MISSING).
	Code string
	// Missing is the publish-gate key list. Empty is omitted.
	Missing []string
}

func (f *Fail) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

// AsFail reports a Fail in err.
func AsFail(err error) (*Fail, bool) {
	var f *Fail
	if errors.As(err, &f) {
		return f, true
	}
	return nil, false
}

// Actor is the platform account already authenticated by the edge.
// Role is user, admin, or super_admin. OrgID may be 0.
type Actor struct {
	UserID int64
	OrgID  int64
	Role   string
}
