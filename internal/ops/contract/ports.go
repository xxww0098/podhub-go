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
	StoreID    string    `json:"store_id"`
	Ordered    *float64  `json:"ordered_units_30d,omitempty"`
	Previous   *float64  `json:"previous_ordered_units_30d,omitempty"`
	DaySeries  []float64 `json:"day_series_14d,omitempty"`
	ThroughDay string    `json:"through_day,omitempty"`
	LastSyncMS *int64    `json:"last_sync_at_ms,omitempty"`
	LastError  string    `json:"last_error,omitempty"`
	RetryAtMS  *int64    `json:"retry_at_ms,omitempty"`
}

// ProductRow is one store_product_sync projection. Nil counts mean never synced.
type ProductRow struct {
	StoreID               string `json:"store_id"`
	CountTotal            *int64 `json:"count_total,omitempty"`
	CountOnSale           *int64 `json:"count_on_sale,omitempty"`
	CountHidden           *int64 `json:"count_hidden,omitempty"`
	CountModerationFailed *int64 `json:"count_moderation_failed,omitempty"`
	CountZeroStock        *int64 `json:"count_zero_stock,omitempty"`
	CountArchived         *int64 `json:"count_archived,omitempty"`
	LastFullSync          *int64 `json:"last_full_sync_at_ms,omitempty"`
	Pass                  string `json:"pass,omitempty"`
	Hold                  string `json:"hold,omitempty"`
	HoldUntilMS           *int64 `json:"hold_until_ms,omitempty"`
	HoldReason            string `json:"hold_reason,omitempty"`
	PricedAtMS            *int64 `json:"priced_at_ms_max,omitempty"`
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
