package domain

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
)

type readyJSON struct {
	Value *bool
}

func (r *readyJSON) UnmarshalJSON(raw []byte) error {
	if string(raw) == "null" {
		r.Value = nil
		return nil
	}
	var v bool
	if err := json.Unmarshal(raw, &v); err != nil {
		return err
	}
	r.Value = &v
	return nil
}

type orderVector struct {
	Name    string `json:"name"`
	Current string `json:"current"`
	Lines   []struct {
		Ready  readyJSON `json:"ready"`
		Packet string    `json:"packet"`
	} `json:"lines"`
	WantComputed string `json:"want_computed"`
	WantStored   string `json:"want_stored"`
}

func TestOrderRecomputeVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/order_recompute.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []orderVector
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) < 8 {
		t.Fatalf("vectors %d", len(rows))
	}
	allowed := map[string]bool{
		"awaiting_setup": true, "ready": true, "dispatched": true,
		"in_production": true, "shipped": true,
	}
	for _, row := range rows {
		lines := make([]Line, len(row.Lines))
		for i, line := range row.Lines {
			lines[i] = Line{Ready: line.Ready.Value, Packet: line.Packet}
		}
		got := ComputeOrderState(lines)
		if got != row.WantComputed || !allowed[got] {
			t.Fatalf("%s computed %s", row.Name, got)
		}
		stored := StoredOrderState(row.Current, lines)
		if stored != row.WantStored {
			t.Fatalf("%s stored %s", row.Name, stored)
		}
	}
}

func TestOrderTransitionsAreUnproven(t *testing.T) {
	states := []string{"awaiting_setup", "ready", "dispatched", "in_production", "shipped", "done", "cancelled", "bogus"}
	for _, from := range states {
		for _, to := range states {
			if err := TransitionOrder(from, to); err != contract.ErrUnproven {
				t.Fatalf("%s -> %s: %v", from, to, err)
			}
		}
	}
}
