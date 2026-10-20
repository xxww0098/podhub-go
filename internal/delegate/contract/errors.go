// Package contract is the delegate domain's public types and sentinel errors.
// It has no I/O.
package contract

import "errors"

// Level is the architecture level for delegate. tests/archtest is not in
// this tree yet; docs/parity/delegate-parity.md records the same number.
const Level = 3

var (
	// ErrNotFound is DELEGATE_NOT_FOUND from delegate_supplier_*.
	ErrNotFound = errors.New("DELEGATE_NOT_FOUND")
	// ErrForbidden is DELEGATE_FORBIDDEN: the user is not an active member.
	ErrForbidden = errors.New("DELEGATE_FORBIDDEN")
	// ErrTerminal is DELEGATE_TERMINAL: the dispatch or order edge is closed.
	ErrTerminal = errors.New("DELEGATE_TERMINAL")
	// ErrUnknownAction is not a SQL exception. The function set has no such action.
	ErrUnknownAction = errors.New("unknown delegate action")
	// ErrUnproven means the edge is not in the copied SQL functions.
	ErrUnproven = errors.New("delegate transition is not proven")
	// ErrNotPorted is the HTTP and outbound stand-in. No request is sent.
	ErrNotPorted = errors.New("not_ported")
	// ErrUnavailable means the repository has no database begin function.
	ErrUnavailable = errors.New("database unavailable")
	// ErrNoTenant means neither an org id nor a supplier user id was supplied.
	ErrNoTenant = errors.New("missing tenant")
)

// DispatchView is one packet as list queries return it. JSON shape for the
// seller and supplier handlers is not proven, so HTTP does not emit this.
type DispatchView struct {
	DispatchID string
	State      string
}
