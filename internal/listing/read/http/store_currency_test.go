package readhttp

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestProjectStoreCurrencyUsesTheDestinationContract(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := startClaimDB(t, ctx)
	org, _, _ := seedOwner(t, ctx, pool, "storecur")
	const store = "c5000000-0000-4000-8000-000000000001"
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_stores (org_id, uuid, create_order, name, company_currency)
		VALUES ($1, $2::uuid, 1, '合同店', 'cny')`, org, store); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	payload := []byte(`{"targetStoreId":"` + store + `","defaults":{"values":{"currency_code":{"kind":"text","value":"RUB"}},"cleared":["currency_code","vat"]}}`)
	out, err := projectStoreCurrency(ctx, tx, org, payload, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := projectedCurrency(t, out); got != "CNY" {
		t.Errorf("currency = %q, want the destination contract CNY", got)
	}
	var doc struct {
		Defaults struct {
			Cleared []string `json:"cleared"`
		} `json:"defaults"`
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Defaults.Cleared) != 1 || doc.Defaults.Cleared[0] != "vat" {
		t.Errorf("cleared = %v, want only the unrelated vat entry", doc.Defaults.Cleared)
	}

	fallbackOut, err := projectStoreCurrency(ctx, tx, org, []byte(`{}`), strPtr(store))
	if err != nil {
		t.Fatal(err)
	}
	if got := projectedCurrency(t, fallbackOut); got != "CNY" {
		t.Errorf("fallback currency = %q, want CNY", got)
	}
}

func TestProjectStoreCurrencyLeavesUnknownOrDeletedStoresAlone(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := startClaimDB(t, ctx)
	org, _, _ := seedOwner(t, ctx, pool, "storecur-gone")
	const store = "c5000000-0000-4000-8000-000000000002"
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_stores (org_id, uuid, create_order, name, company_currency, deleted_at_ms)
		VALUES ($1, $2::uuid, 1, '停用店', 'CNY', 1)`, org, store); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for name, payload := range map[string]string{
		"deleted store": `{"targetStoreId":"` + store + `"}`,
		"unknown store": `{"targetStoreId":"c5000000-0000-4000-8000-0000000000ff"}`,
		"not a store":   `{"targetStoreId":"draft"}`,
		"no target":     `{}`,
	} {
		out, err := projectStoreCurrency(ctx, tx, org, []byte(payload), nil)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if string(out) != payload {
			t.Errorf("%s changed payload: %s", name, out)
		}
	}
}

func projectedCurrency(t *testing.T, payload []byte) string {
	t.Helper()
	var doc struct {
		Defaults struct {
			Values map[string]struct {
				Value string `json:"value"`
			} `json:"values"`
		} `json:"defaults"`
	}
	if err := json.Unmarshal(payload, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Defaults.Values["currency_code"].Value
}

func strPtr(value string) *string { return &value }
