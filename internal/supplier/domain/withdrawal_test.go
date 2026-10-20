package domain

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
)

type withdrawalVector struct {
	Name       string `json:"name"`
	Cents      int64  `json:"cents"`
	Channel    string `json:"channel"`
	Open       bool   `json:"open"`
	WantStatus string `json:"want_status"`
	WantMicro  int64  `json:"want_microfen"`
	Err        string `json:"err"`
}

func TestWithdrawalRequestVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/withdrawal_requests.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []withdrawalVector
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) < 6 {
		t.Fatalf("vectors %d", len(rows))
	}
	for _, row := range rows {
		got, err := Request(row.Cents, row.Channel, row.Open)
		if row.Err != "" {
			if err != contract.ErrInvalid {
				t.Fatalf("%s: %v", row.Name, err)
			}
			continue
		}
		if err != nil || got.Status != row.WantStatus || got.AmountMicrofen != row.WantMicro || got.AmountCents != row.Cents || got.Channel != row.Channel {
			t.Fatalf("%s: %+v %v", row.Name, got, err)
		}
		if got.AmountMicrofen != got.AmountCents*contract.MicrofenPerCent {
			t.Fatalf("%s microfen", row.Name)
		}
	}
}

func TestWithdrawalStatuses(t *testing.T) {
	states := []string{"requested", "paid", "rejected", "", "held"}
	for _, state := range states {
		want := state == "requested" || state == "paid" || state == "rejected"
		if ValidWithdrawalStatus(state) != want {
			t.Fatalf("status %s", state)
		}
	}
}

func TestLevel(t *testing.T) {
	if contract.Level != 3 {
		t.Fatal(contract.Level)
	}
}
