package domain

import (
	"encoding/json"
	"testing"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

func TestPriceReceiptNeedsExactCompleteItems(t *testing.T) {
	m := Mutation{OperationID: "00000000-0000-4000-8000-000000000001", Kind: "price", Raw: json.RawMessage(`{"items":[{"product_id":41,"offer_id":"a","price":"62.01","old_price":"0","currency_code":"CNY"},{"product_id":42,"offer_id":"b","price":"63.01","old_price":"0","currency_code":"CNY"}]}`)}
	for _, tc := range []struct {
		name, body string
		unknown    bool
		succeeded  int
	}{
		{"reordered mixed result", `{"result":[{"product_id":42,"offer_id":"b","updated":false,"errors":[{"code":"PRICE","message":"invalid price"}]},{"product_id":41,"offer_id":"a","updated":true,"errors":[]}]}`, false, 1},
		{"contradictory update is unknown", `{"result":[{"product_id":41,"offer_id":"a","updated":true,"errors":[{"code":"PRICE"}]},{"product_id":42,"offer_id":"b","updated":true,"errors":[]}]}`, true, 0},
		{"empty object", `{}`, true, 0},
		{"bad JSON", `{`, true, 0},
		{"missing row", `{"result":[{"product_id":41,"offer_id":"a","updated":true,"errors":[]}]}`, true, 0},
		{"mismatched product", `{"result":[{"product_id":41,"offer_id":"a","updated":true,"errors":[]},{"product_id":99,"offer_id":"b","updated":true,"errors":[]}]}`, true, 0},
		{"duplicate row", `{"result":[{"product_id":41,"offer_id":"a","updated":true,"errors":[]},{"product_id":41,"offer_id":"a","updated":true,"errors":[]}]}`, true, 0},
		{"missing updated", `{"result":[{"product_id":41,"offer_id":"a","errors":[]},{"product_id":42,"offer_id":"b","updated":true,"errors":[]}]}`, true, 0},
		{"null errors", `{"result":[{"product_id":41,"offer_id":"a","updated":true,"errors":null},{"product_id":42,"offer_id":"b","updated":true,"errors":[]}]}`, true, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			raw, fail, unknown := Dispatch(m, func(method, path string, body []byte) Page {
				calls++
				if method != "POST" || path != "/v1/product/import/prices" {
					t.Fatal("unexpected dispatch")
				}
				return Page{Status: 200, Body: tc.body}
			})
			if calls != 1 || unknown != tc.unknown {
				t.Fatalf("calls=%d unknown=%v fail=%+v", calls, unknown, fail)
			}
			if unknown {
				if fail == nil || fail.Code != contract.CodeSellerUnknown || len(raw) != 0 {
					t.Fatal("malformed receipt was settled")
				}
				return
			}
			var got mutationView
			if fail != nil || json.Unmarshal(raw, &got) != nil || len(got.Items) != 2 || got.Items[0].Identity != "a" || got.Items[1].Identity != "b" {
				t.Fatalf("receipt=%s fail=%+v", raw, fail)
			}
			success := 0
			for _, it := range got.Items {
				if it.Succeeded {
					success++
				} else if it.Message == "" {
					t.Fatal("failed receipt lacks message")
				}
			}
			if success != tc.succeeded {
				t.Fatalf("success=%d", success)
			}
		})
	}
}

func TestPriceValidationUsesExactBoundedAmounts(t *testing.T) {
	for _, tc := range []struct {
		price, old, currency string
		bad                  bool
	}{
		{"62.01", "0", "CNY", false}, {"62.01", "70.00", "RUB", false},
		{"0", "0", "CNY", true}, {"1e2", "0", "CNY", true}, {"1.001", "0", "CNY", true},
		{"62.01", "62.01", "CNY", true}, {"62.01", "60", "CNY", true}, {"62.01", "0", "", true}, {"10000000000", "0", "CNY", true},
	} {
		raw, _ := json.Marshal(map[string]any{"items": []any{map[string]any{"product_id": 41, "offer_id": "a", "price": tc.price, "old_price": tc.old, "currency_code": tc.currency}}})
		if (validatePrice(raw) != nil) != tc.bad {
			t.Fatalf("price=%s old=%s currency=%s", tc.price, tc.old, tc.currency)
		}
	}
	if validatePrice([]byte(`{"items":[{"product_id":41,"offer_id":"a","price":"1","old_price":"0","currency_code":"CNY"},{"product_id":41,"offer_id":"b","price":"2","old_price":"0","currency_code":"CNY"}]}`)) == nil {
		t.Fatal("duplicate product accepted")
	}
}
