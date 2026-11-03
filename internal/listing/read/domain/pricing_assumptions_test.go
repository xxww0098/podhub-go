package domain

import (
	"bytes"
	"strings"
	"testing"
)

const pricingFixture = `{"currency":"RUB","costs":[{"name":"采购","amount":"80.00","currency":"CNY","exchangeRate":"12.34567890"}],"fees":[{"name":"人工佣金假设","rateBps":1000}],"targetMarginBps":2000}`

func TestPricingAssumptionsAreTypedCardMetadata(t *testing.T) {
	card := `{"categoryKey":"k","descriptionCategoryId":1,"typeId":2,"aiFieldPolicy":{"allowed_field_keys":[],"protected_field_keys":[]},"pricingAssumptions":` + pricingFixture + `}`
	encoded, err := PrepareCard([]byte(card), nil)
	if err != nil || !bytes.Contains(encoded, []byte(`"pricingAssumptions"`)) || !bytes.Contains(encoded, []byte(`"exchangeRate":"12.34567890"`)) {
		t.Fatalf("metadata roundtrip %s %v", encoded, err)
	}
	for _, bad := range []string{
		strings.Replace(pricingFixture, `"rateBps":1000`, `"rateBps":10000`, 1),
		strings.Replace(pricingFixture, `"rateBps":1000`, `"rateBps":null`, 1),
		strings.Replace(pricingFixture, `"targetMarginBps":2000`, `"targetMarginBps":9000`, 1),
		strings.Replace(pricingFixture, `"80.00"`, `"-1"`, 1),
		strings.Replace(pricingFixture, `"80.00"`, `"1.001"`, 1),
		strings.Replace(pricingFixture, `,"exchangeRate":"12.34567890"`, ``, 1),
		strings.Replace(pricingFixture, `"12.34567890"`, `"0"`, 1),
		strings.Replace(pricingFixture, `"12.34567890"`, `"999999999"`, 1),
		strings.Replace(pricingFixture, `"currency":"CNY"`, `"currency":"RUB"`, 1),
		strings.Replace(pricingFixture, `"currency":"RUB"`, `"currency":"USD"`, 1),
		`null`, `{}`, strings.Replace(pricingFixture, `"fees":[{"name":"人工佣金假设","rateBps":1000}]`, `"fees":null`, 1),
	} {
		if _, err := normalizePricingAssumptions([]byte(bad)); err == nil {
			t.Fatalf("bad assumptions accepted: %s", bad)
		}
	}
}
