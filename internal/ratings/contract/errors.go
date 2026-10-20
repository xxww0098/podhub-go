// Package contract is the ratings domain's exported errors and the Seller
// info path. It has no I/O.
package contract

import "errors"

const (
	// SellerInfoPath is the read-only Seller method the sync posts.
	// ST1's refresh-store-info function is not on main (5caa713). The
	// worker adapter posts this path through the existing Seller egress
	// read (rate limit, loopback dialer). When that refresh function
	// lands, the adapter should call it instead of posting the path.
	SellerInfoPath = "/v1/seller/info"

	// KindWorsened is the notifications.kind written when a mapped status
	// moves to a strictly worse rank.
	KindWorsened = "store_rating_worsened"
)

var (
	// ErrNotFound is a missing store or a store the caller cannot see.
	ErrNotFound = errors.New("store not found")
	// ErrForbidden is a session without a usable workspace membership.
	ErrForbidden = errors.New("member unavailable")
	// ErrBadQuery is a list or history query the handler rejects.
	ErrBadQuery = errors.New("bad query")
	// ErrNoCredential means the store has nothing to open. The text does
	// not include a client id or an API key.
	ErrNoCredential = errors.New("store credential is missing")
	// ErrUnavailable is a database or wiring failure.
	ErrUnavailable = errors.New("unavailable")
)
