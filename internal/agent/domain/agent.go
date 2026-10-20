package domain

import "time"

// Agent is one public.agents row the session user is allowed to see.
type Agent struct {
	UserID          int64
	InviteCode      string
	Status          string
	Payout          Payout
	ReviewFlaggedAt *time.Time
}

// Policy is the singleton agent_rebate_policy row.
type Policy struct {
	DefaultRebateBps        int32
	MinOrderCents           int64
	AttributionValidityDays int32
	MinWithdrawCents        int64
}

// Withdrawal is one agent_withdrawals row for the session user.
type Withdrawal struct {
	ID              int64
	PublicID        string
	AmountCents     int64
	Channel         string
	Account         string
	RealName        string
	Status          string
	Reference       *string
	RejectReason    *string
	RequestedAt     time.Time
	DecidedAt       *time.Time
	DecidedByUserID *int64
}

// CommissionView is one workbench commission row after mask_email.
// CreatedAt is the SQL to_char UTC timestamp, not a Go format.
type CommissionView struct {
	ID               int64
	InviteeEmail     string
	WorkspaceName    string
	Product          string
	OrderAmountCents int64
	RebateBps        int64
	AmountCents      int64
	Status           string
	Note             string
	CreatedAt        string
}

// LedgerView is one agent-facing ledger row. Withdrawal halves are omitted.
type LedgerView struct {
	EntryType         string
	AmountCents       int64
	HeldDeltaCents    int64
	BalanceAfterCents int64
	Note              string
	CreatedAt         string
}

// WithdrawalView is one agent-facing withdrawal. Nil optionals are omitted
// on the wire (skip_serializing_if).
type WithdrawalView struct {
	PublicID     string
	AmountCents  int64
	Channel      string
	Account      string
	RealName     string
	Status       string
	Reference    *string
	RejectReason *string
	RequestedAt  string
	DecidedAt    *string
}

// Transfer is the wallet-transfer success body.
type Transfer struct {
	OperationID           string
	AmountCents           int64
	WalletBalanceMicrofen int64
	WorkspaceUUID         string
	WorkspaceName         string
}

// Workbench is the read set behind GET /api/agent.
// AvailableCents is balance - held, not saturating_sub.
// JSON field order is applied by the HTTP structs.
type Workbench struct {
	Agent             *Agent
	Wallet            Wallet
	Policy            Policy
	AvailableCents    int64
	TransferAvailable bool
	InviteeCount      int64
	CreditedCount     int64
	SkippedCount      int64
	CreditedTotal     int64
	Commissions       []CommissionView
}
