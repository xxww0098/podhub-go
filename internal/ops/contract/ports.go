package contract

import "context"

// Lane is the egress slot a Seller call takes.
type Lane int

const (
	LaneRead Lane = iota
	LaneInteractiveRead
	LaneWrite
	LaneInteractiveWrite
)

// Secret is an opened seller credential. It is not logged.
type Secret struct {
	ClientID string
	APIKey   string
}

// Admitted is one store the caller may use.
type Admitted struct {
	StorePK int64
	UUID    string
	Secret  Secret
}

// Seller is the loopback egress. WritesDisabled is the captured switch.
type Seller interface {
	Call(ctx context.Context, lane Lane, method, path string, body []byte, secret Secret) (status int, resp string, err error)
	WritesDisabled() bool
}

// Stores admits one store. It does not call Ozon and does not read the kill switch.
type Stores interface {
	Admit(ctx context.Context, orgID, userID int64, role, storeID string, nowMS int64) (Admitted, error)
}

// LedgerRow is a begin_write outcome. Inserted means this caller owns dispatching.
type LedgerRow struct {
	Inserted bool
	State    string
	Status   int
	Body     []byte
}

// Ledger is seller_upstream_writes inside a tenant transaction.
type Ledger interface {
	Begin(ctx context.Context, orgID, storePK int64, key, hash, kind string, body []byte) (LedgerRow, error)
	Settle(ctx context.Context, orgID, storePK int64, key, hash string, status int, body []byte) error
	MarkUnknown(ctx context.Context, orgID, storePK int64, key, hash, code, message string, backoffSec int) error
	Heartbeat(ctx context.Context, orgID, storePK int64, key string) error
}

// StoreHead is one roster row the console projection needs.
type StoreHead struct {
	PK             int64
	UUID           string
	Name           string
	CreateOrder    int64
	ClientID       string
	ManualDisabled bool
	QuotaSuspended bool
	CredentialRev  int64
	Configured     bool
	AssigneeID     *int64
	AssigneeName   string
	AssigneeEmail  string
	Revision       int64
	CanManage      bool
}

// LedgerEntry is one snapshot ledger row before status_from_wire.
type LedgerEntry struct {
	Kind      string
	Status    string
	CreatedMS int64
	UpdatedMS int64
}

// MetricRow is one console_store_metrics projection.
type MetricRow struct {
	StoreID    string
	Ordered    *float64
	Previous   *float64
	DaySeries  []float64
	ThroughDay string
	LastSyncMS *int64
	LastError  string
	RetryAtMS  *int64
}

// ProductRow is one store_product_sync projection. Nil counts mean never synced.
type ProductRow struct {
	StoreID               string
	CountTotal            *int64
	CountOnSale           *int64
	CountHidden           *int64
	CountModerationFailed *int64
	CountZeroStock        *int64
	CountArchived         *int64
	LastFullSync          *int64
	Pass                  string
	Hold                  string
	HoldUntilMS           *int64
	HoldReason            string
	PricedAtMS            *int64
}

// RosterMeta is the org-level half of the overview. The loader SQL was not
// pasted in the spec; these numbers are the columns this repo can read.
type RosterMeta struct {
	StoreLimit int64
	StoresUsed int64
	Suspended  int64
}

// UnknownWrite is one result_unknown ledger row inside the visible live set.
type UnknownWrite struct {
	ID              string
	StorePK         int64
	StoreUUID       string
	Key             string
	Kind            string
	Body            []byte
	Passes          int
	LastObservation []byte
}

// ConsoleRead is the snapshot and the reconcile list.
type ConsoleRead interface {
	Roster(ctx context.Context, orgID, userID int64, role string) ([]StoreHead, RosterMeta, error)
	Ledger(ctx context.Context, orgID int64, cap int) ([]LedgerEntry, error)
	Metrics(ctx context.Context, orgID int64, stores []string) ([]MetricRow, error)
	Products(ctx context.Context, orgID int64, stores []string) ([]ProductRow, error)
	ListUnknown(ctx context.Context, orgID int64, stores []string, limit int) ([]UnknownWrite, error)
	ApplyProbe(ctx context.Context, orgID int64, id, state, observation, errCode, message string, backoffSec int) error
}

// Refresher holds the advisory lock across the seller fan-out.
type Refresher interface {
	Refresh(ctx context.Context, orgID int64, stores []string, nowMS int64, pull func(storeID string) (ordered float64, days []float64, through string, syncMS int64, fail string, retry *int64, err error)) (results []RefreshResult, metrics []MetricRow, err error)
}

// RefreshResult is one store this round actually tried.
type RefreshResult struct {
	StoreID string
	Failed  bool
	Error   string
}
