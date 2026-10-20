package domain

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestCatalogFillAndAuditMatchLegacy(t *testing.T) {
	empty := Product{ProductID: "p"}
	got := FillProduct(empty)
	if len(got.Media) != 0 || got.Specs == nil || len(got.Specs) != 0 {
		t.Fatalf("%+v", got)
	}
	kept := FillProduct(Product{Media: []string{"a"}, Specs: map[string]string{"k": "v"}})
	if len(kept.Media) != 1 || kept.Specs["k"] != "v" {
		t.Fatalf("%+v", kept)
	}
	sku := FillSKU(SKU{SKUID: "s"})
	if sku.Media == nil || sku.Specs == nil {
		t.Fatalf("%+v", sku)
	}

	price := int64(12)
	cases := []struct{ got, want string }{
		{ProductAudit("棉袜", false, 1), legacyProductAudit("棉袜", false, 1)},
		{ProductAudit("<b>", true, 2), legacyProductAudit("<b>", true, 2)},
		{SKUAudit("袜", "C", true, 3, &price), legacySKUAudit("袜", "C", true, 3, &price)},
		{SKUAudit("袜", "C", false, 4, nil), legacySKUAudit("袜", "C", false, 4, nil)},
	}
	for _, c := range cases {
		if c.got != c.want || bytes.Contains([]byte(c.got), []byte(`\u003c`)) {
			t.Fatalf("got %s want %s", c.got, c.want)
		}
	}
}

func legacyProductAudit(title string, published bool, revision int64) string {
	raw, _ := legacyMarshal(struct {
		Summary   string `json:"summary"`
		Published bool   `json:"published"`
		Revision  int64  `json:"revision"`
	}{title, published, revision})
	return string(raw)
}

func legacySKUAudit(title, code string, published bool, revision int64, price *int64) string {
	raw, _ := legacyMarshal(struct {
		Summary      string `json:"summary"`
		PlatformCode string `json:"platformCode"`
		Published    bool   `json:"published"`
		Revision     int64  `json:"revision"`
		PriceCents   *int64 `json:"priceCents"`
	}{title, code, published, revision, price})
	return string(raw)
}

func legacyMarshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
