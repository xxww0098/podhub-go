package service

import (
	"context"
	"strings"
	"testing"
)

func TestFindPostingSnapshotKeyOrder(t *testing.T) {
	s := Seller{Edge: Edge{Seller: func(_ context.Context, _, _, path string, body []byte) (int, []byte, string, error) {
		if !strings.Contains(path, "/v4/posting/fbs/unfulfilled/list") {
			t.Fatalf("path %s", path)
		}
		if !strings.Contains(string(body), `"sort_dir":"ASC"`) || strings.Contains(string(body), `"statuses"`) {
			t.Fatalf("body %s", body)
		}
		return 200, []byte(`{"postings":[{"posting_number":"P1","status":"awaiting_packaging","substatus":"","in_process_at":"2026-01-01T00:00:00Z","shipment_date":"2026-01-02T00:00:00Z","products":[{"sku":1,"offer_id":"O","name":"n","quantity":2}]}],"has_next":false}`), "", nil
	}}}
	lines, snap, err := s.findPosting(context.Background(), "client", "key", "P1")
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || lines[0].OfferID != "O" || lines[0].Quantity != 2 {
		t.Fatalf("lines %+v", lines)
	}
	const want = `{"status":"awaiting_packaging","substatus":"","in_process_at":"2026-01-01T00:00:00Z","shipment_date":"2026-01-02T00:00:00Z"}`
	if string(snap) != want {
		t.Fatalf("snapshot %s", snap)
	}
}
