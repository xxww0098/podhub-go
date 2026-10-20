// Package contract is the agent domain's public surface: actors, DTOs, and
// sentinel errors. It has no I/O.
package contract

import "errors"

var (
	// ErrNotPorted means the Rust handler body was not available to compare,
	// so the call must not pretend to succeed.
	ErrNotPorted = errors.New("not_ported")
	// ErrUnauthenticated is a missing user on the session.
	ErrUnauthenticated = errors.New("unauthenticated")
	// ErrMissingOrg means the tenant transaction was not given an org id.
	ErrMissingOrg = errors.New("missing org")
	// ErrUnavailable means the database seam is not configured.
	ErrUnavailable = errors.New("unavailable")
	// ErrIllegalEdge is a withdrawal transition the schema does not allow.
	ErrIllegalEdge = errors.New("illegal edge")
	// ErrInvalidShape is a row the CHECK constraints would reject.
	ErrInvalidShape = errors.New("invalid shape")
	// ErrNotAgent means this user has no agents row.
	ErrNotAgent = errors.New("not agent")
	// ErrWriteOnce is account_users_attribution_no_rewrite.
	ErrWriteOnce = errors.New("attribution is write-once")
	// ErrSelfInvite is account_users_not_self_invited.
	ErrSelfInvite = errors.New("self invite")
)

// Failure kinds are mapped to HTTP only in the http package.
const (
	KindUnauth     = "unauth"
	KindValidation = "validation"
	KindNotFound   = "not_found"
	KindConflict   = "conflict"
	KindInternal   = "internal"
	KindBusy       = "busy"
	KindMedia      = "media"
	KindDisabled   = "disabled"
)

// Failure is a domain answer whose message is already the wire text.
// RetryAfter is set for the lock-timeout SQLSTATE. It is "1" or empty.
type Failure struct {
	Kind       string
	Msg        string
	RetryAfter string
}

func (f *Failure) Error() string {
	if f == nil {
		return ""
	}
	return f.Msg
}

// Fail builds a Failure. The http layer owns the status code.
func Fail(kind, msg string) *Failure {
	return &Failure{Kind: kind, Msg: msg}
}

// FailBusy is SQLSTATE 55P03: 503, Retry-After 1, the caller's code unchanged.
func FailBusy() *Failure {
	return &Failure{Kind: KindBusy, Msg: "资源正在更新，请稍后重试", RetryAfter: "1"}
}

// Actor is the session user. OrgID 0 means the tenant seam has no org.
// The value comes from the session, never from a request body.
type Actor struct {
	UserID int64
	OrgID  int64
}
