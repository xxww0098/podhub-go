package domain

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
)

type withdrawalVector struct {
	Name    string `json:"name"`
	From    string `json:"from"`
	Edge    string `json:"edge"`
	Reason  string `json:"reason"`
	To      string `json:"to"`
	Decided bool   `json:"decided"`
	Legal   bool   `json:"legal"`
	Err     string `json:"err"`
}

func TestWithdrawalEdgesFromSchema(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "withdrawal_edges.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors []withdrawalVector
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	legal := map[string]bool{}
	for _, v := range vectors {
		got, err := ApplyWithdrawal(v.From, v.Edge, v.Reason)
		if v.Legal {
			if err != nil {
				t.Fatalf("%s: %v", v.Name, err)
			}
			if got.Status != v.To || got.Decided != v.Decided {
				t.Fatalf("%s: %+v", v.Name, got)
			}
			if v.Edge == EdgeReject && got.Reason != v.Reason {
				t.Fatalf("%s reason %q", v.Name, got.Reason)
			}
			legal[v.From+"|"+v.Edge] = true
			continue
		}
		want := contract.ErrIllegalEdge
		if v.Err == "invalid_shape" {
			want = contract.ErrInvalidShape
		}
		if !errors.Is(err, want) {
			t.Fatalf("%s: got %v", v.Name, err)
		}
	}

	// Every status the CHECK names, plus one stranger, crossed with every
	// named edge plus one stranger. A pair is legal only when the vector
	// file says so. Reason is non-blank so a reject does not fail the shape.
	statuses := []string{StatusNone, StatusPending, StatusPaid, StatusRejected, "credited"}
	edges := []string{EdgeRequest, EdgePay, EdgeReject, "cancel"}
	for _, from := range statuses {
		for _, edge := range edges {
			_, err := ApplyWithdrawal(from, edge, "reason")
			if legal[from+"|"+edge] {
				if err != nil {
					t.Fatalf("named %s|%s: %v", from, edge, err)
				}
				continue
			}
			if !errors.Is(err, contract.ErrIllegalEdge) {
				t.Fatalf("illegal %s|%s: %v", from, edge, err)
			}
		}
	}
}

func TestOnePendingWithdrawal(t *testing.T) {
	if err := RequestAllowed(false); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(RequestAllowed(true), contract.ErrIllegalEdge) {
		t.Fatal("second pending must fail")
	}
}
