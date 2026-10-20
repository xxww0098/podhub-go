package domain

import (
	"testing"

	"github.com/xxww0098/podhub-go/internal/supply/contract"
)

func TestOrderAndProcurementEdgesFail(t *testing.T) {
	orders := []string{"awaiting_payment", "awaiting_procurement", "processing", "in_production", "shipped", "cancelled"}
	for _, status := range orders {
		want := status != "cancelled"
		if ValidOrderStatus(status) != want {
			t.Fatalf("order %s", status)
		}
	}
	procs := []string{"prepared", "dispatching", "accepted", "rejected", "unknown", "shipped"}
	for _, status := range procs {
		want := status != "shipped"
		if ValidProcurementStatus(status) != want {
			t.Fatalf("procurement %s", status)
		}
	}
	for _, from := range orders {
		for _, to := range orders {
			if err := TransitionOrder(from, to); err != contract.ErrUnproven {
				t.Fatalf("order %s -> %s", from, to)
			}
		}
	}
	for _, from := range procs {
		for _, to := range procs {
			if err := TransitionProcurement(from, to); err != contract.ErrUnproven {
				t.Fatalf("procurement %s -> %s", from, to)
			}
		}
	}
}

func TestLevel(t *testing.T) {
	if contract.Level != 3 {
		t.Fatal(contract.Level)
	}
}
