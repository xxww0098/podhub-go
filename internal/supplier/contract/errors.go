// Package contract is the supplier portal's public types and sentinel errors.
package contract

import "errors"

// Level is the architecture level for supplier.
const Level = 3

var (
	// ErrInvalid is a CHECK failure: amount, channel, or a second open request.
	ErrInvalid = errors.New("invalid withdrawal")
	// ErrUnproven means the status edge has no SQL function in db/migrations.
	ErrUnproven = errors.New("supplier transition is not proven")
	// ErrNoTenant means neither an org id nor a supplier user id was supplied.
	ErrNoTenant = errors.New("missing tenant")
	// ErrUnavailable means the repository has no database begin function.
	ErrUnavailable = errors.New("database unavailable")
	// ErrNotPorted is the HTTP and asset-download stand-in. No request is sent.
	ErrNotPorted = errors.New("not_ported")
)

// MicrofenPerCent is ck_supplier_withdrawals_amount:
// amount_microfen = amount_cents * 1000000.
const MicrofenPerCent int64 = 1_000_000

// Withdrawal is the row a supplier request would insert. Persistence is refused
// until the ledger posting matches a SQL function.
type Withdrawal struct {
	AmountCents    int64
	AmountMicrofen int64
	Channel        string
	Status         string
}

// Wallet is the supplier_wallets projection. The HTTP envelope is not proven.
type Wallet struct {
	SourceID        string
	BalanceMicrofen int64
	HeldMicrofen    int64
}

// WithdrawalRow is a stored withdrawal as a list query returns it.
type WithdrawalRow struct {
	WithdrawalID string
	SourceID     string
	Status       string
	AmountCents  int64
}
