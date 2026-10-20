package domain

import (
	"testing"

	"github.com/xxww0098/podhub-go/internal/supply/contract"
)

func TestOrderAndProcurementStatuses(t *testing.T) {
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
}

func TestLevel(t *testing.T) {
	if contract.Level != 3 {
		t.Fatal(contract.Level)
	}
}
