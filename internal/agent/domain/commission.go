package domain

import "github.com/xxww0098/podhub-go/internal/agent/contract"

const (
	CommissionCredited = "credited"
	CommissionSkipped  = "skipped"
)

// CommissionShape matches agent_commissions_status_shape. Credited requires
// a positive amount and a non-nil ledger key. Skipped requires a zero amount
// and a nil key. An empty key is not nil, so it only fits credited.
func CommissionShape(status string, amountCents int64, ledgerKey *string) error {
	switch status {
	case CommissionCredited:
		if amountCents > 0 && ledgerKey != nil {
			return nil
		}
	case CommissionSkipped:
		if amountCents == 0 && ledgerKey == nil {
			return nil
		}
	}
	return contract.ErrInvalidShape
}

// RebateBps matches every agent bps CHECK: 0 through 10000, inclusive.
func RebateBps(bps int) error {
	if bps < 0 || bps > 10000 {
		return contract.ErrInvalidShape
	}
	return nil
}
