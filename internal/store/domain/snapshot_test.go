package domain

import (
	"encoding/json"
	"testing"
)

// The stored snapshot is served to the SPA unchanged, so its keys are the
// WorkspaceStoreFinanceBalance contract. The SPA reads currency_code and
// fetched_at_ms; a camelCase spelling leaves it with no currency and shows the
// balance as unavailable.
func TestFinanceBalanceServesContractKeys(t *testing.T) {
	balance := FinanceBalanceFromOzon(200,
		[]byte(`{"total":{"closing_balance":{"value":1520.5,"currency_code":"cny"}}}`), "2026-10-26", 1_760_000_000_000)
	raw, err := json.Marshal(balance)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"outcome": "ready", "amount": "1520.50", "currency_code": "CNY",
		"period_to": "2026-10-26", "fetched_at_ms": float64(1_760_000_000_000),
	}
	if len(wire) != len(want) {
		t.Fatalf("keys %v, want %v", wire, want)
	}
	for key, value := range want {
		if wire[key] != value {
			t.Fatalf("%s = %v, want %v (wire %s)", key, wire[key], value, raw)
		}
	}

	view := Row{FinanceBalance: raw}.FinanceBalanceView()
	if view == nil || view.CurrencyCode == nil || *view.CurrencyCode != "CNY" || view.FetchedAtMS != 1_760_000_000_000 {
		t.Fatalf("round trip lost fields: %+v", view)
	}
}

// The quota snapshot is served unchanged too. The SPA reads daily_create,
// fetched_at_ms and categories[].category_id; the old camelCase keys left the
// quota bars empty.
func TestProductQuotaServesContractKeys(t *testing.T) {
	archived := int64(4)
	quota := ProductQuotaFromOzon([]byte(`{
		"daily_create":{"limit":100,"usage":12},
		"total":{"limit":1000,"usage":367,"quota_by_category":[{"category_id":17027,"limit":50,"usage":7}]}
	}`), &archived, 1_760_000_000_000)
	raw, err := json.Marshal(quota)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		FetchedAtMS int64 `json:"fetched_at_ms"`
		DailyCreate *struct {
			Limit, Usage int64
		} `json:"daily_create"`
		Total struct {
			Archived   int64 `json:"archived"`
			Categories []struct {
				CategoryID int64 `json:"category_id"`
				Usage      int64 `json:"usage"`
			} `json:"categories"`
		} `json:"total"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if wire.FetchedAtMS != 1_760_000_000_000 || wire.DailyCreate == nil || wire.DailyCreate.Limit != 100 ||
		wire.Total.Archived != 4 || len(wire.Total.Categories) != 1 || wire.Total.Categories[0].CategoryID != 17027 {
		t.Fatalf("wire %s", raw)
	}
	view := Row{ProductQuota: raw}.ProductQuotaView()
	if view == nil || view.FetchedAtMS != 1_760_000_000_000 || view.DailyCreate == nil || (*view.Total.Categories)[0].CategoryID != 17027 {
		t.Fatalf("round trip lost fields: %+v", view)
	}
}
