package contract

import "errors"

// ErrBadBody is a browser import-info payload the server will not store.
var ErrBadBody = errors.New("ozon error body")

// ErrTooMany means the payload has more error items than the route accepts.
// Nothing from that payload is stored.
var ErrTooMany = errors.New("ozon error batch")

// ErrBadQuery is a list filter, sort, or cursor the server will not run.
var ErrBadQuery = errors.New("ozon error query")
