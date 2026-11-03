package observerepo

import (
	"encoding/json"
	"testing"
)

func TestObservationProductWireUsesSharedPropertyNames(t *testing.T) {
	for _, tc := range []struct {
		value any
		keys  []string
	}{
		{obsWorkspace{}, []string{"owner_uuid", "owner_name"}},
		{obsStore{}, []string{"store_id", "store_name", "workspace_id", "workspace_name"}},
		{overviewStore{}, []string{"store_id", "count_on_sale", "last_full_sync_at_ms"}},
		{countTotals{}, []string{"on_sale", "zero_stock", "moderation_failed"}},
		{productItem{}, []string{"owner_uuid", "workspace_id", "workspace_name"}},
		{productRow{}, []string{"store_id", "product_id", "stock_present", "old_price"}},
		{productMetrics{}, []string{"ordered_units", "fx_as_of", "revenue_currency", "fetched_at_ms"}},
	} {
		raw, err := json.Marshal(tc.value)
		if err != nil {
			t.Fatal(err)
		}
		var properties map[string]any
		if err := json.Unmarshal(raw, &properties); err != nil {
			t.Fatal(err)
		}
		for _, key := range tc.keys {
			if _, ok := properties[key]; !ok {
				t.Errorf("%T missing %s: %s", tc.value, key, raw)
			}
		}
	}
}
