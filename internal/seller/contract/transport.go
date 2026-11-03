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

// StoreBinding is backed by existing submission intents, never a browser credential.
// ReadOnly reconciles already accepted work without granting new write authority.
type StoreBinding struct {
	OrgID, UserID, StorePK int64
	StoreUUID              string
	IntentIDs              []string
	ReadOnly               bool
}

type StoreTransport interface {
	Transport
	BindStore(context.Context, StoreBinding) (Transport, error)
}

type PhysicalAccountTransport interface{ PhysicalAccountKey() string }

// ErrNotSent is a connect refusal. No request left the process.
var ErrNotSent = errors.New("seller write did not leave the process")

// ErrWritesDisabled means the configured Ozon write gate is closed.
var ErrWritesDisabled = errors.New("OZON_WRITE_KILL_SWITCH is engaged; Ozon writes are closed")
