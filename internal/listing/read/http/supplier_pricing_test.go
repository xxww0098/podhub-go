package readhttp

import (
	"bytes"
	"strings"
	"testing"
)

func TestSupplierPricingOnlyAddsOwnedMetadata(t *testing.T) {
	base := []byte(`{"categoryKey":"k","descriptionCategoryId":1,"typeId":2,"supplierProductId":"supplier-1","aiFieldPolicy":{"allowed_field_keys":[],"protected_field_keys":[]}}`)
	patch := []byte(`{"pricingAssumptions":{"currency":"CNY","costs":[{"name":"成本","amount":"1.00","currency":"CNY"}],"fees":[],"targetMarginBps":2000}}`)
	merged, msg, ok := supplierOverlay(base, patch)
	if !ok {
		t.Fatal(msg)
	}
	encoded, err := PrepareCard(merged, nil)
	if err != nil || !bytes.Contains(encoded, []byte(`"pricingAssumptions"`)) || !bytes.Contains(encoded, []byte(`"supplierProductId":"supplier-1"`)) {
		t.Fatalf("%s %v", encoded, err)
	}
	if _, _, ok := supplierOverlay(base, []byte(`{"aiPromptId":"changed-online-config"}`)); ok {
		t.Fatal("pricing opened the supplier's online config")
	}
}

func TestSupplierPricingApplyIsNotAdmitted(t *testing.T) {
	base := []byte(`{"defaults":{"values":{"currency_code":{"kind":"text","value":"CNY"}}}}`)
	patch := `{"pricingAssumptions":{"currency":"CNY"},"defaults":{"values":{"price":{"kind":"text","value":"1.25"}}}}`
	if _, _, ok := supplierOverlay(base, []byte(patch)); ok {
		t.Fatal("supplier quote application admitted with an explicit currency")
	}
	for _, current := range [][]byte{nil, []byte(`{"defaults":{"values":{}}}`), []byte(strings.Replace(string(base), `"CNY"`, `"RUB"`, 1))} {
		if _, _, ok := supplierOverlay(current, []byte(patch)); ok {
			t.Fatal("applied a quote against an unknown or different currency")
		}
	}
	if _, msg, ok := supplierOverlay(base, []byte(`{"defaults":{"values":{"price":{"kind":"text","value":"2.00"}}}}`)); !ok {
		t.Fatalf("ordinary manual pricing changed: %s", msg)
	}
}
