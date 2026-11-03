package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func TestListingPricingAssumptionsRoundTrip(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	engine := tagsEngine(t)
	owner, org := insertWorkspace(t, ctx, pool, "pricing-a@example.invalid", "Pricing A")
	_, otherOrg := insertWorkspace(t, ctx, pool, "pricing-b@example.invalid", "Pricing B")
	principal := access.Principal{UserID: owner, OrgID: org, WorkspaceRole: "owner", PlatformRole: "user"}
	h := surfaceHandler(pool, engine, principal, time.Now)
	foreign := surfaceHandler(pool, engine, access.Principal{UserID: owner, OrgID: otherOrg, WorkspaceRole: "owner", PlatformRole: "user"}, time.Now)
	const card = "e1111111-1111-4111-8111-111111111111"
	base := `{"categoryKey":"k","descriptionCategoryId":1,"typeId":2,"defaults":{"values":{"currency_code":{"kind":"text","value":"CNY"},"price":{"kind":"text","value":"5.00"},"old_price":{"kind":"text","value":"200.00"}},"complex_values":[]},"aiFieldPolicy":{"allowed_field_keys":[],"protected_field_keys":[]}}`
	insertCard(t, ctx, pool, card, org, "Pricing", "2026-10-22 00:00:00+00", base)
	const assumptions = `{"currency":"RUB","costs":[{"name":"采购成本","amount":"80.00","currency":"CNY","exchangeRate":"12.34567890"},{"name":"物流","amount":"100.01","currency":"RUB"}],"fees":[{"name":"人工佣金假设","rateBps":1000}],"targetMarginBps":2000}`
	var payload map[string]json.RawMessage
	if err := json.Unmarshal([]byte(base), &payload); err != nil {
		t.Fatal(err)
	}
	patch := func(baseRevision int, parameters string) string {
		payload["pricingAssumptions"] = json.RawMessage(parameters)
		encoded, err := json.Marshal(map[string]any{"baseRevision": baseRevision, "payload": payload})
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	path := "/api/listing/cards/" + card
	res := callJSON(h, http.MethodPatch, path, patch(1, assumptions))
	if res.Code != http.StatusOK {
		t.Fatalf("save %d %s", res.Code, res.Body.String())
	}
	var expected any
	if err := json.Unmarshal([]byte(assumptions), &expected); err != nil {
		t.Fatal(err)
	}
	check := func(handler http.Handler) {
		t.Helper()
		read := callJSON(handler, http.MethodGet, path, "")
		var response struct {
			Data struct {
				Revision int            `json:"revision"`
				Payload  map[string]any `json:"payload"`
			} `json:"data"`
		}
		if read.Code != http.StatusOK || json.Unmarshal(read.Body.Bytes(), &response) != nil || response.Data.Revision != 2 || !reflect.DeepEqual(response.Data.Payload["pricingAssumptions"], expected) || !strings.Contains(read.Body.String(), `"value":"5.00"`) {
			t.Fatalf("readback %d %s", read.Code, read.Body.String())
		}
	}
	check(surfaceHandler(pool, engine, principal, time.Now))
	var persisted bool
	if err := pool.QueryRow(ctx, `SELECT payload->'pricingAssumptions' = $2::jsonb AND revision = 2 FROM listing_cards WHERE id = $1::uuid`, card, assumptions).Scan(&persisted); err != nil || !persisted {
		t.Fatalf("persistence: %v %v", persisted, err)
	}
	if stale := callJSON(h, http.MethodPatch, path, patch(1, assumptions)); stale.Code != http.StatusConflict {
		t.Fatalf("stale %d %s", stale.Code, stale.Body.String())
	}
	if denied := callJSON(foreign, http.MethodPatch, path, patch(2, assumptions)); denied.Code != http.StatusNotFound {
		t.Fatalf("foreign %d %s", denied.Code, denied.Body.String())
	}
	for _, invalid := range []string{
		strings.Replace(assumptions, `"rateBps":1000`, `"rateBps":10000`, 1),
		strings.Replace(assumptions, `"targetMarginBps":2000`, `"targetMarginBps":9000`, 1),
		strings.Replace(assumptions, `"80.00"`, `"-80.00"`, 1),
		strings.Replace(assumptions, `"80.00"`, `"80.001"`, 1),
		strings.Replace(assumptions, `,"exchangeRate":"12.34567890"`, ``, 1),
	} {
		bad := callJSON(h, http.MethodPatch, path, patch(2, invalid))
		if bad.Code != http.StatusBadRequest {
			t.Fatalf("invalid %d %s", bad.Code, bad.Body.String())
		}
		check(h)
	}
	// Apply the independently verified CNY quote to the ordinary card through
	// the real PATCH route, retaining its other default fields.
	const cnyAssumptions = `{"currency":"CNY","costs":[{"name":"成本","amount":"80.00","currency":"CNY"}],"fees":[{"name":"人工佣金假设","rateBps":1000}],"targetMarginBps":2000}`
	payload["defaults"] = json.RawMessage(`{"values":{"currency_code":{"kind":"text","value":"CNY"},"price":{"kind":"text","value":"114.29"},"old_price":{"kind":"text","value":"200.00"}},"complex_values":[]}`)
	applied := callJSON(h, http.MethodPatch, path, patch(2, cnyAssumptions))
	if applied.Code != http.StatusOK {
		t.Fatalf("ordinary apply %d %s", applied.Code, applied.Body.String())
	}
	readApplied := callJSON(surfaceHandler(pool, engine, principal, time.Now), http.MethodGet, path, "")
	if readApplied.Code != http.StatusOK || !strings.Contains(readApplied.Body.String(), `"value":"114.29"`) || !strings.Contains(readApplied.Body.String(), `"value":"200.00"`) {
		t.Fatalf("ordinary apply readback %d %s", readApplied.Code, readApplied.Body.String())
	}
	if err := pool.QueryRow(ctx, `SELECT payload->'pricingAssumptions' = $2::jsonb AND revision = 3 AND payload#>>'{defaults,values,price,value}' = '114.29' AND payload#>>'{defaults,values,old_price,value}' = '200.00' FROM listing_cards WHERE id = $1::uuid`, card, cnyAssumptions).Scan(&persisted); err != nil || !persisted {
		t.Fatalf("ordinary apply persistence: %v %v", persisted, err)
	}
	// A supplier card may persist trial inputs, but cannot apply a quote even
	// when an explicit matching currency happens to exist on the document.
	const supplierCard = "e2222222-2222-4222-8222-222222222222"
	supplierBase := strings.TrimSuffix(base, "}") + `,"supplierProductId":"pricing-supplier-fixture"}`
	insertCard(t, ctx, pool, supplierCard, org, "Supplier pricing", "2026-10-22 00:00:00+00", supplierBase)
	supplierPath := "/api/listing/cards/" + supplierCard
	stored := callJSON(h, http.MethodPatch, supplierPath, `{"baseRevision":1,"payload":{"pricingAssumptions":`+cnyAssumptions+`}}`)
	if stored.Code != http.StatusOK {
		t.Fatalf("supplier save %d %s", stored.Code, stored.Body.String())
	}
	fresh := callJSON(surfaceHandler(pool, engine, principal, time.Now), http.MethodGet, supplierPath, "")
	if fresh.Code != http.StatusOK || !strings.Contains(fresh.Body.String(), `"pricingAssumptions"`) || !strings.Contains(fresh.Body.String(), `"amount":"80.00"`) {
		t.Fatalf("supplier readback %d %s", fresh.Code, fresh.Body.String())
	}
	apply := callJSON(h, http.MethodPatch, supplierPath, `{"baseRevision":2,"payload":{"pricingAssumptions":`+cnyAssumptions+`,"defaults":{"values":{"price":{"kind":"text","value":"114.29"}},"complex_values":[]}}}`)
	if apply.Code != http.StatusBadRequest || !strings.Contains(apply.Body.String(), "仅可试算") {
		t.Fatalf("supplier application not admitted %d %s", apply.Code, apply.Body.String())
	}
	if err := pool.QueryRow(ctx, `SELECT payload->'pricingAssumptions' = $2::jsonb AND revision = 2 AND payload#>>'{defaults,values,price,value}' = '5.00' FROM listing_cards WHERE id = $1::uuid`, supplierCard, cnyAssumptions).Scan(&persisted); err != nil || !persisted {
		t.Fatalf("supplier persistence: %v %v", persisted, err)
	}
}
