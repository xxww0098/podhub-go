package domain

import (
	"time"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
)

// Wallet is agent_commission_wallets, without the row's clock column.
type Wallet struct {
	BalanceCents int64
	HeldCents    int64
	Version      int64
}

// LedgerEntry is one agent_commission_ledger row.
type LedgerEntry struct {
	ID                 int64
	EntryType          string
	IdempotencyKey     string
	AmountCents        int64
	HeldDeltaCents     int64
	BalanceBeforeCents int64
	BalanceAfterCents  int64
	HeldBeforeCents    int64
	HeldAfterCents     int64
	CommissionID       *int64
	WithdrawalID       *int64
	Note               string
	CreatedAt          time.Time
}

// entryTypes is agent_commission_ledger_type_known.
func knownEntry(entryType string) bool {
	switch entryType {
	case "commission", "transfer_out", "withdrawal_hold", "withdrawal_paid", "withdrawal_release":
		return true
	default:
		return false
	}
}

// ApplyLedger checks the entry type and the wallet CHECKs
// (balance >= 0, 0 <= held <= balance) after adding amount and held delta.
// The signs of amount and held delta are the caller's. This function does
// not invent a Rust posting formula.
func ApplyLedger(before Wallet, entryType string, amount, heldDelta int64) (Wallet, error) {
	if !knownEntry(entryType) {
		return Wallet{}, contract.ErrInvalidShape
	}
	after := Wallet{
		BalanceCents: before.BalanceCents + amount,
		HeldCents:    before.HeldCents + heldDelta,
		Version:      before.Version,
	}
	if after.BalanceCents < 0 || after.HeldCents < 0 || after.HeldCents > after.BalanceCents {
		return Wallet{}, contract.ErrInvalidShape
	}
	return after, nil
}

// ValidLedgerRow checks the two ledger equations and the wallet bounds on
// the after side. It does not assign signs.
func ValidLedgerRow(row LedgerEntry) error {
	if !knownEntry(row.EntryType) {
		return contract.ErrInvalidShape
	}
	if row.BalanceAfterCents != row.BalanceBeforeCents+row.AmountCents {
		return contract.ErrInvalidShape
	}
	if row.HeldAfterCents != row.HeldBeforeCents+row.HeldDeltaCents {
		return contract.ErrInvalidShape
	}
	if row.BalanceAfterCents < 0 || row.HeldAfterCents < 0 || row.HeldAfterCents > row.BalanceAfterCents {
		return contract.ErrInvalidShape
	}
	if row.BalanceBeforeCents < 0 || row.HeldBeforeCents < 0 || row.HeldBeforeCents > row.BalanceBeforeCents {
		return contract.ErrInvalidShape
	}
	return nil
}
