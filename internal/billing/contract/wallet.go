package contract

import (
	"fmt"
	"time"
)

// WalletRow is the locked cache. Available is balance saturating-subtract held.
type WalletRow struct {
	BalanceMicrofen int64
	HeldMicrofen    int64
}

func (w WalletRow) Available() int64 {
	if w.HeldMicrofen > w.BalanceMicrofen {
		return 0
	}
	return w.BalanceMicrofen - w.HeldMicrofen
}

// WalletView is the HTTP wallet. UpdatedAt is RFC3339 milliseconds, Zulu.
type WalletView struct {
	BalanceMicrofen   int64
	HeldMicrofen      int64
	AvailableMicrofen int64
	SpentMicrofen     int64
	UpdatedAt         time.Time
}

// LedgerEntryView is one recent ledger row.
type LedgerEntryView struct {
	EntryType            string
	AmountMicrofen       int64
	BalanceAfterMicrofen int64
	Note                 string
	CreatedAt            time.Time
}

// Settlement is one settle movement. Absorbed is platform loss, never a debt.
type Settlement struct {
	ChargedMicrofen  int64
	AbsorbedMicrofen int64
	Wallet           WalletRow
}

// Error is a wallet refusal. Insufficient is the only funds refusal.
type Error struct {
	Msg          string
	Available    int64
	Required     int64
	Insufficient bool
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Insufficient {
		return fmt.Sprintf("工作空间钱包余额不足：可用 %s，需要 %s", yuan(e.Available), yuan(e.Required))
	}
	return e.Msg
}

// RFC3339Millis matches Rust SecondsFormat::Millis with Zulu.
func RFC3339Millis(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// yuan renders microfen as a yuan amount with up to six decimals trimmed to
// at least two, so a ¥0.003 reservation does not read as ¥0.00.
func yuan(microfen int64) string {
	s := fmt.Sprintf("%.8f", float64(microfen)/100_000_000)
	for len(s) > 0 && s[len(s)-1] == '0' && s[len(s)-3] != '.' {
		s = s[:len(s)-1]
	}
	return "¥" + s
}
