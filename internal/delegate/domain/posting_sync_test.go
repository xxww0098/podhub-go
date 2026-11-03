package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParsePostingSnapshot(t *testing.T) {
	posting := `{"posting_number":"P1","status":"awaiting_packaging","substatus":"ready","shipment_date":"2026-10-30","customer":{"name":"PRIVATE"},"analytics_data":{"warehouse":"Moscow","city":"City","customer_phone":"PRIVATE"},"delivery_method":{"name":"OGL"}}`
	for _, raw := range []string{posting, `{"result":` + posting + `}`} {
		update, err := ParsePostingSnapshot([]byte(raw), "P1")
		if err != nil || update.Status != "awaiting_packaging" || !json.Valid(update.Snapshot) || !json.Valid(update.Logistics) || !strings.Contains(string(update.Logistics), "Moscow") || strings.Contains(string(update.Snapshot)+string(update.Logistics), "PRIVATE") {
			t.Fatalf("snapshot: %+v err=%v", update, err)
		}
	}
	update, err := ParsePostingSnapshot([]byte(`{"result":{"posting_number":"P1","status":"delivered","shipment_date":"2026-10-30"}}`), "P1")
	if err != nil || update.Logistics != nil {
		t.Fatalf("missing logistics became dispatchable: %+v err=%v", update, err)
	}
	for _, raw := range []string{
		`{`, `null`, `{"result":null}`,
		`{"posting_number":"P2","status":"cancelled"}`,
		`{"posting_number":"P1","status":" "}`,
		`{"posting_number":"P1","status":1}`,
		`{"posting_number":"P1","status":"delivered","substatus":{"private":"data"}}`,
		`{"posting_number":"P1","status":"delivered","analytics_data":{"city":{}}}`,
	} {
		if _, err := ParsePostingSnapshot([]byte(raw), "P1"); err == nil {
			t.Fatalf("accepted malformed posting: %s", raw)
		}
	}
}
