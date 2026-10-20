package contract

import (
	"context"
	"errors"
)

// Transport is the Seller egress. Write is /v3/product/import. Read is a
// probe and must work while writes are disabled.
type Transport interface {
	Write(ctx context.Context, path string, body []byte) (status int, resp string, err error)
	Read(ctx context.Context, path string, body []byte) (status int, resp string, err error)
	WritesDisabled() bool
	// Ready is nil when the next Write may leave the process. ErrNotSent
	// means it will not: the intent is still queued.
	Ready(ctx context.Context) error
}

// ErrNotSent is a connect refusal. No request left the process.
var ErrNotSent = errors.New("seller write did not leave the process")
