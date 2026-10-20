package domain

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
)

type ledgerVector struct {
	Name          string `json:"name"`
	EntryType     string `json:"entry_type"`
	BeforeBalance int64  `json:"before_balance"`
	BeforeHeld    int64  `json:"before_held"`
	Amount        int64  `json:"amount"`
	HeldDelta     int64  `json:"held_delta"`
	OK            bool   `json:"ok"`
}

func TestLedgerShapesMatchChecks(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "ledger_shapes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors []ledgerVector
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		before := Wallet{BalanceCents: v.BeforeBalance, HeldCents: v.BeforeHeld}
		after, err := ApplyLedger(before, v.EntryType, v.Amount, v.HeldDelta)
		if v.OK {
			if err != nil {
				t.Fatalf("%s: %v", v.Name, err)
			}
			row := LedgerEntry{
				EntryType:          v.EntryType,
				AmountCents:        v.Amount,
				HeldDeltaCents:     v.HeldDelta,
				BalanceBeforeCents: before.BalanceCents,
				BalanceAfterCents:  after.BalanceCents,
				HeldBeforeCents:    before.HeldCents,
				HeldAfterCents:     after.HeldCents,
			}
			if err := ValidLedgerRow(row); err != nil {
				t.Fatalf("%s row: %v", v.Name, err)
			}
			continue
		}
		if !errors.Is(err, contract.ErrInvalidShape) {
			t.Fatalf("%s: got %v", v.Name, err)
		}
	}
}

func TestLedgerEquationMismatch(t *testing.T) {
	row := LedgerEntry{
		EntryType: "commission", AmountCents: 10,
		BalanceBeforeCents: 0, BalanceAfterCents: 9,
	}
	if !errors.Is(ValidLedgerRow(row), contract.ErrInvalidShape) {
		t.Fatal("balance equation")
	}
	row.BalanceAfterCents = 10
	row.HeldDeltaCents = 1
	row.HeldAfterCents = 0
	if !errors.Is(ValidLedgerRow(row), contract.ErrInvalidShape) {
		t.Fatal("held equation")
	}
}
