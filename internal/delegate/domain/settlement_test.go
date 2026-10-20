package domain

import (
	"testing"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
)

func TestSettlementEdgesFail(t *testing.T) {
	states := []string{"held", "settled", "released", "", "paid"}
	for _, state := range states {
		want := state == "held" || state == "settled" || state == "released"
		if ValidSettlement(state) != want {
			t.Fatalf("valid %q", state)
		}
	}
	for _, from := range states {
		for _, to := range states {
			if err := TransitionSettlement(from, to); err != contract.ErrUnproven {
				t.Fatalf("%s -> %s: %v", from, to, err)
			}
		}
	}
}

func TestLevel(t *testing.T) {
	if contract.Level != 3 {
		t.Fatal(contract.Level)
	}
}
