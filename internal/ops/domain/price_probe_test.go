package domain

import (
	"encoding/json"
	"testing"
)

func TestPriceProbeNeedsCompleteMatchingReadback(t *testing.T) {
	request := []byte(`{"kind":"price","items":[{"product_id":41,"offer_id":"a","price":"62.01","old_price":"70.00","currency_code":"CNY"}]}`)
	for _, tc := range []struct{ name, reply, verdict string }{
		{"applied", `{"items":[{"product_id":41,"offer_id":"a","price":{"price":"62.010","old_price":"70","currency_code":"CNY"}}]}`, "applied"},
		{"different", `{"items":[{"product_id":41,"offer_id":"a","price":{"price":"60","old_price":"70","currency_code":"CNY"}}]}`, "contradicted"},
		{"empty object", `{}`, "indeterminate"},
		{"empty list", `{"items":[]}`, "indeterminate"},
		{"wrong offer", `{"items":[{"product_id":41,"offer_id":"other","price":{"price":"62.01","old_price":"70","currency_code":"CNY"}}]}`, "indeterminate"},
		{"missing old price", `{"items":[{"product_id":41,"offer_id":"a","price":{"price":"62.01","currency_code":"CNY"}}]}`, "indeterminate"},
		{"missing currency", `{"items":[{"product_id":41,"offer_id":"a","price":{"price":"62.01","old_price":"70"}}]}`, "indeterminate"},
		{"rational is not currency", `{"items":[{"product_id":41,"offer_id":"a","price":{"price":"6201/100","old_price":"70","currency_code":"CNY"}}]}`, "indeterminate"},
		{"exponent is not currency", `{"items":[{"product_id":41,"offer_id":"a","price":{"price":"6.201e1","old_price":"70","currency_code":"CNY"}}]}`, "indeterminate"},
		{"duplicate", `{"items":[{"product_id":41,"offer_id":"a"},{"product_id":41,"offer_id":"a"}]}`, "indeterminate"},
		{"truncated", `{"items":[],"cursor":"more"}`, "indeterminate"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			kind, summary := Observe("product_mutation", request, func(method, path string, body []byte) Page {
				calls++
				if method != "POST" || path != pricesPath {
					t.Fatalf("unexpected write %s %s", method, path)
				}
				var sent struct {
					Filter struct {
						IDs []int64 `json:"product_id"`
					} `json:"filter"`
				}
				if json.Unmarshal(body, &sent) != nil || len(sent.Filter.IDs) != 1 || sent.Filter.IDs[0] != 41 {
					t.Fatalf("unbounded price read %s", body)
				}
				return Page{Status: 200, Body: tc.reply}
			}, nil)
			if calls != 1 || kind != tc.verdict {
				t.Fatalf("calls=%d kind=%s summary=%s", calls, kind, summary)
			}
			if kind == "contradicted" {
				if Decide(kind, 0, nil, summary).State != "result_unknown" {
					t.Fatal("one mismatch must not release the target")
				}
				last, _ := json.Marshal(summary)
				if Decide(kind, 1, last, summary).State != "conflict" {
					t.Fatal("two matching observations must resolve the target")
				}
			}
		})
	}
}
