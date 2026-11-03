package service

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

const reconcileStoreUUID = "11111111-1111-4111-8111-111111111111"

type reconcileConsole struct {
	unknown []contract.UnknownWrite
	probes  map[string]string
}

func (*reconcileConsole) Roster(context.Context, int64, int64, string) ([]contract.StoreHead, contract.RosterMeta, error) {
	return []contract.StoreHead{{PK: 1, UUID: reconcileStoreUUID}}, contract.RosterMeta{}, nil
}
func (*reconcileConsole) Ledger(context.Context, int64, int) ([]contract.LedgerEntry, error) {
	return nil, nil
}
func (*reconcileConsole) Metrics(context.Context, int64, []string) ([]contract.MetricRow, error) {
	return nil, nil
}
func (*reconcileConsole) Products(context.Context, int64, []string) ([]contract.ProductRow, error) {
	return nil, nil
}
func (c *reconcileConsole) ListUnknown(context.Context, int64, []string, int) ([]contract.UnknownWrite, error) {
	return c.unknown, nil
}
func (c *reconcileConsole) ApplyProbe(_ context.Context, _ int64, id, state, _, _, _ string, _ int) error {
	c.probes[id] = state
	return nil
}

type reconcileSeller struct{}

func (reconcileSeller) Call(_ context.Context, lane contract.Lane, _ string, path string, body []byte, _ contract.Secret) (int, string, error) {
	if lane != contract.LaneRead || path != "/v2/product/info/stocks-by-warehouse/fbs" {
		return 500, ``, nil
	}
	if bytes.Contains(body, []byte(`"42"`)) {
		return 200, `{"products":[{"sku":42,"warehouse_id":8,"present":0}],"has_next":false,"cursor":""}`, nil
	}
	return 200, `{"products":[{"sku":41,"warehouse_id":7,"present":1}],"has_next":false,"cursor":""}`, nil
}
func (reconcileSeller) WritesDisabled() bool { return true }

func TestReconcileReportsCountsThatMatchItsEntries(t *testing.T) {
	console := &reconcileConsole{probes: map[string]string{}, unknown: []contract.UnknownWrite{
		{ID: "matched", StorePK: 1, StoreUUID: reconcileStoreUUID, Key: "SKU-41", Kind: "product_mutation",
			Body: []byte(`{"kind":"stock","items":[{"sku":41,"warehouse_id":7,"stock":1}]}`)},
		{ID: "mismatched", StorePK: 1, StoreUUID: reconcileStoreUUID, Key: "SKU-42", Kind: "product_mutation",
			Body: []byte(`{"kind":"stock","items":[{"sku":42,"warehouse_id":8,"stock":1}]}`)},
		{ID: "unreachable-store", StorePK: 2, StoreUUID: "not-a-uuid", Key: "SKU-43", Kind: "product_mutation",
			Body: []byte(`{"kind":"stock","items":[{"sku":43,"warehouse_id":9,"stock":1}]}`)},
	}}
	screen := Screen{Stores: sendStore{}, Console: console, Seller: reconcileSeller{}}
	raw, fail := screen.Reconcile(context.Background(), Actor{UserID: 1, OrgID: 1, Role: "member"})
	if fail != nil {
		t.Fatal(fail)
	}
	var out struct {
		Data struct {
			Reconciled   int64 `json:"reconciled"`
			Conflicted   int64 `json:"conflicted"`
			StillUnknown int64 `json:"still_unknown"`
			Skipped      int64 `json:"skipped"`
			Entries      []struct {
				IntentID string `json:"intent_id"`
				Outcome  string `json:"outcome"`
				Reason   string `json:"reason"`
			} `json:"entries"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("response %s: %v", raw, err)
	}
	d := out.Data
	if d.Reconciled != 1 || d.Conflicted != 0 || d.StillUnknown != 1 || d.Skipped != 1 || len(d.Entries) != 3 {
		t.Fatalf("counts recon=%d conflict=%d unknown=%d skipped=%d entries=%d", d.Reconciled, d.Conflicted, d.StillUnknown, d.Skipped, len(d.Entries))
	}
	want := map[string]string{"matched": "reconciled", "mismatched": "still_unknown", "unreachable-store": "skipped"}
	for _, entry := range d.Entries {
		if want[entry.IntentID] != entry.Outcome {
			t.Fatalf("entry %s outcome %s (%s)", entry.IntentID, entry.Outcome, entry.Reason)
		}
	}
	if console.probes["matched"] != "reconciled" || console.probes["mismatched"] != "result_unknown" || console.probes["unreachable-store"] != "" {
		t.Fatalf("applied probes %v", console.probes)
	}
}
