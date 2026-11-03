package contract

import (
	"strings"
	"testing"
)

func TestPromotionCatalogRejectsMalformedSuccess(t *testing.T) {
	for _, body := range []string{`{}`, `{"result":null}`, `{"result":{}}`, `{"result":[{"id":0,"title":"bad"}]}`, `{"result":[{"id":12}]}`, `{"result":[{"id":12,"title":"Campaign","action_type":"ELASTIC_BOOSTING","potential_products_count":0,"participating_products_count":0}]}`} {
		if _, err := ParsePromotionActions([]byte(body)); err == nil {
			t.Fatalf("malformed catalog accepted: %s", body)
		}
	}
	body := `{"result":[{"id":12,"title":"Campaign","action_type":"ELASTIC_BOOSTING","is_participating":false,"freeze_date":"","potential_products_count":0,"participating_products_count":0}]}`
	if rows, err := ParsePromotionActions([]byte(body)); err != nil || len(rows) != 1 {
		t.Fatalf("rows=%+v err=%v", rows, err)
	}
}

func TestPromotionProductsPreserveMoneyFlatBoostsAndUnknowns(t *testing.T) {
	body := `{"products":[{"id":41,"price":{"amount":"99.123456","currency":"CNY"},"action_price":{"amount":"88.01","currency":"RUB"},"max_action_price":{"amount":"50.00","currency":"RUB"},"current_boost":12.5,"price_min_elastic":{"amount":"30.001","currency":"RUB"}}],"total":120,"last_id":"short-page-cursor"}`
	page, err := ParsePromotionProducts([]byte(body))
	if err != nil || len(page.Products) != 1 {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	row := page.Products[0]
	if row.Price.Amount != "99.123456" || row.MaxActionPrice.Amount != "50.00" || row.Price.Currency != "CNY" || row.CurrentBoost == nil || *row.CurrentBoost != 12.5 || row.Stock != nil || row.MinStock != nil || row.MinBoost != nil || row.PriceQuarantined != nil || page.LastID != "short-page-cursor" {
		t.Fatalf("lost Seller values: %+v", row)
	}
	for _, bad := range []string{strings.Replace(body, `"products":[`, `"products":null,"ignored":[`, 1), strings.Replace(body, `"currency":"RUB"`, `"currency":"rub"`, 1), strings.Replace(body, `"99.123456"`, `99.123456`, 1), strings.Replace(body, `"current_boost":12.5`, `"stock":-1`, 1), strings.Replace(body, `short-page-cursor`, `bad\nvalue`, 1)} {
		if _, err := ParsePromotionProducts([]byte(bad)); err == nil {
			t.Fatalf("malformed products accepted: %s", bad)
		}
	}
}

func TestPromotionDetailsRetainUint64SKUAndExactIdentities(t *testing.T) {
	body := `{"items":[{"id":41,"offer_id":"real-offer","name":"Real product","sources":[{"sku":18446744073709551615}]}]}`
	rows, err := ParsePromotionDetails([]byte(body), []int64{41})
	if err != nil || len(rows) != 1 || rows[0].SKU != "18446744073709551615" {
		t.Fatalf("rows=%+v err=%v", rows, err)
	}
	for _, bad := range []string{`{}`, `{"items":[]}`, strings.Replace(body, `"id":41`, `"id":42`, 1), strings.Replace(body, `"real-offer"`, `""`, 1), strings.Replace(body, `18446744073709551615`, `18446744073709551616`, 1)} {
		if _, err := ParsePromotionDetails([]byte(bad), []int64{41}); err == nil {
			t.Fatalf("malformed identity accepted: %s", bad)
		}
	}
}

func TestPromotionPricesAcceptExactNumbersAndTerminalCursorForFilteredIDs(t *testing.T) {
	for _, amount := range []string{`60`, `"60.0100"`} {
		body := `{"items":[{"product_id":41,"offer_id":"real-offer","price":{"price":` + amount + `,"currency_code":"CNY"}}],"total":1,"total_items":1,"cursor":"terminal-cursor"}`
		rows, err := ParsePromotionPrices([]byte(body), []int64{41})
		if err != nil || len(rows) != 1 || rows[0].Price != strings.Trim(amount, `"`) {
			t.Fatalf("prices=%+v err=%v", rows, err)
		}
		for _, bad := range []string{strings.Replace(body, `"total":1`, `"total":2`, 1), strings.Replace(body, `"total_items":1`, `"total_items":2`, 1), strings.Replace(body, `"product_id":41`, `"product_id":42`, 1), strings.Replace(body, `"currency_code":"CNY"`, `"currency_code":""`, 1)} {
			if _, err := ParsePromotionPrices([]byte(bad), []int64{41}); err == nil {
				t.Fatalf("incomplete filtered prices accepted: %s", bad)
			}
		}
	}
}
