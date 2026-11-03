package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

func promotionMutation(kind, body string) Mutation {
	return Mutation{OperationID: "00000000-0000-4000-8000-000000000001", StoreID: "store", Kind: kind, Raw: json.RawMessage(body)}
}

func TestPromotionJoinUsesExactMoneyAndTypeSpecificStock(t *testing.T) {
	for _, kind := range []string{"PROMOCODE", "ELASTIC_BOOSTING", "STOCK_DISCOUNT"} {
		t.Run(kind, func(t *testing.T) {
			m := promotionMutation("promotion_join", fmt.Sprintf(`{"action_id":7,"action_type":%q,"items":[{"product_id":41,"offer_id":"a","action_price":"55.01","currency_code":"RUB","stock":0},{"product_id":42,"offer_id":"b","action_price":"1499.5","currency_code":"CNY","stock":0}]}`, kind))
			if fail := ValidateMutation(m); fail != nil {
				t.Fatal(fail)
			}
			raw, fail, unknown := Dispatch(m, func(method, path string, body []byte) Page {
				if method != "POST" || path != "/v1/actions/products/update" {
					t.Fatal("unexpected promotion route")
				}
				stock := ""
				if kind == "PROMOCODE" {
					stock = `,"stock":0`
				}
				want := `{"action_id":7,"products":[{"product_id":41,"action_price":{"amount":"55.01","currency":"RUB"}` + stock + `},{"product_id":42,"action_price":{"amount":"1499.5","currency":"CNY"}` + stock + `}]}`
				if string(body) != want {
					t.Fatalf("body=%s want=%s", body, want)
				}
				return okPage(`{"active_product_ids":[42,"41"],"deactivated_product_ids":[],"rejected":[],"warnings":[]}`)
			})
			var view mutationView
			if fail != nil || unknown || json.Unmarshal(raw, &view) != nil || len(view.Items) != 2 || !view.Items[0].Succeeded || !view.Items[1].Succeeded || view.Items[0].Identity != "41" || view.Items[1].Identity != "42" {
				t.Fatalf("view=%s fail=%v unknown=%v", raw, fail, unknown)
			}
		})
	}
}

func TestPromotionLeaveRoutesAndKeepsCurrency(t *testing.T) {
	for _, kind := range []string{"PROMOCODE", "ELASTIC_BOOSTING", "STOCK_DISCOUNT"} {
		t.Run(kind, func(t *testing.T) {
			exits := ""
			if kind != "PROMOCODE" {
				exits = `,"exit_prices":[{"product_id":42,"exit_price":"1499.50","currency_code":"CNY"},{"product_id":41,"exit_price":"55.01","currency_code":"RUB"}]`
			}
			m := promotionMutation("promotion_leave", fmt.Sprintf(`{"action_id":7,"action_type":%q,"product_ids":[41,42]%s}`, kind, exits))
			if fail := ValidateMutation(m); fail != nil {
				t.Fatal(fail)
			}
			raw, fail, unknown := Dispatch(m, func(method, path string, body []byte) Page {
				if method != "POST" {
					t.Fatal(method)
				}
				if kind == "PROMOCODE" {
					if path != "/v2/actions/products/deactivate" || string(body) != `{"action_id":7,"product_ids":["41","42"]}` {
						t.Fatalf("path=%s body=%s", path, body)
					}
					return okPage(`{"product_ids":["42",41]}`)
				}
				want := `{"action_id":7,"products":[{"product_id":41,"action_price":{"amount":"55.01","currency":"RUB"}},{"product_id":42,"action_price":{"amount":"1499.50","currency":"CNY"}}]}`
				if path != "/v1/actions/products/update" || string(body) != want {
					t.Fatalf("path=%s body=%s", path, body)
				}
				return okPage(`{"active_product_ids":[],"deactivated_product_ids":["42","41"],"rejected":[],"warnings":[]}`)
			})
			var view mutationView
			if fail != nil || unknown || json.Unmarshal(raw, &view) != nil || len(view.Items) != 2 || !view.Items[0].Succeeded || !view.Items[1].Succeeded || view.Items[0].Identity != "41" {
				t.Fatalf("view=%s fail=%v unknown=%v", raw, fail, unknown)
			}
		})
	}
}

func TestPromotionValidationRejectsLossyOrAmbiguousInputsBeforeSending(t *testing.T) {
	join := `{"action_id":7,"action_type":"PROMOCODE","items":[{"product_id":41,"offer_id":"a","action_price":"55.01","currency_code":"RUB","stock":0}]}`
	leave := `{"action_id":7,"action_type":"ELASTIC_BOOSTING","product_ids":[41],"exit_prices":[{"product_id":41,"exit_price":"55.01","currency_code":"RUB"}]}`
	for _, tc := range []struct {
		name, kind, raw string
	}{
		{"missing type", "promotion_join", strings.Replace(join, `"action_type":"PROMOCODE",`, "", 1)},
		{"unknown type", "promotion_join", strings.Replace(join, "PROMOCODE", "DISCOUNT", 1)},
		{"numeric money", "promotion_join", strings.Replace(join, `"55.01"`, `55.01`, 1)},
		{"zero price", "promotion_join", strings.Replace(join, "55.01", "0", 1)},
		{"extra precision", "promotion_join", strings.Replace(join, "55.01", "55.001", 1)},
		{"exponent", "promotion_join", strings.Replace(join, "55.01", "1e2", 1)},
		{"leading zero", "promotion_join", strings.Replace(join, "55.01", "055.01", 1)},
		{"whitespace money", "promotion_join", strings.Replace(join, "55.01", " 55.01", 1)},
		{"oversized money", "promotion_join", strings.Replace(join, "55.01", "10000000000", 1)},
		{"missing currency", "promotion_join", strings.Replace(join, `"currency_code":"RUB",`, "", 1)},
		{"lowercase currency", "promotion_join", strings.Replace(join, "RUB", "rub", 1)},
		{"missing stock", "promotion_join", strings.Replace(join, `,"stock":0`, "", 1)},
		{"null stock", "promotion_join", strings.Replace(join, `"stock":0`, `"stock":null`, 1)},
		{"fractional stock", "promotion_join", strings.Replace(join, `"stock":0`, `"stock":0.1`, 1)},
		{"negative stock", "promotion_join", strings.Replace(join, `"stock":0`, `"stock":-1`, 1)},
		{"boost stock", "promotion_join", strings.Replace(strings.Replace(join, "PROMOCODE", "ELASTIC_BOOSTING", 1), `"stock":0`, `"stock":1`, 1)},
		{"duplicate join product", "promotion_join", `{"action_id":7,"action_type":"PROMOCODE","items":[{"product_id":41,"offer_id":"a","action_price":"1","currency_code":"RUB","stock":0},{"product_id":41,"offer_id":"b","action_price":"1","currency_code":"RUB","stock":0}]}`},
		{"duplicate join offer", "promotion_join", `{"action_id":7,"action_type":"PROMOCODE","items":[{"product_id":41,"offer_id":"a","action_price":"1","currency_code":"RUB","stock":0},{"product_id":42,"offer_id":" a ","action_price":"1","currency_code":"RUB","stock":0}]}`},
		{"out of range ID", "promotion_join", strings.Replace(join, `"product_id":41`, `"product_id":9007199254740992`, 1)},
		{"empty join", "promotion_join", `{"action_id":7,"action_type":"PROMOCODE","items":[]}`},
		{"unknown leave type", "promotion_leave", strings.Replace(leave, "ELASTIC_BOOSTING", "UNKNOWN", 1)},
		{"duplicate leave product", "promotion_leave", strings.Replace(leave, `"product_ids":[41]`, `"product_ids":[41,41]`, 1)},
		{"missing exit price", "promotion_leave", `{"action_id":7,"action_type":"ELASTIC_BOOSTING","product_ids":[41]}`},
		{"partial exit prices", "promotion_leave", strings.Replace(leave, `"product_ids":[41]`, `"product_ids":[41,42]`, 1)},
		{"foreign exit price", "promotion_leave", strings.Replace(leave, `"product_id":41`, `"product_id":42`, 1)},
		{"duplicate exit price", "promotion_leave", `{"action_id":7,"action_type":"ELASTIC_BOOSTING","product_ids":[41,42],"exit_prices":[{"product_id":41,"exit_price":"1","currency_code":"RUB"},{"product_id":41,"exit_price":"1","currency_code":"RUB"}]}`},
		{"numeric exit price", "promotion_leave", strings.Replace(leave, `"55.01"`, `55.01`, 1)},
		{"invalid exit price", "promotion_leave", strings.Replace(leave, "55.01", "-1", 1)},
		{"invalid exit currency", "promotion_leave", strings.Replace(leave, "RUB", "", 1)},
		{"unused promocode exit price", "promotion_leave", strings.Replace(leave, "ELASTIC_BOOSTING", "PROMOCODE", 1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := promotionMutation(tc.kind, tc.raw)
			if fail := ValidateMutation(m); fail == nil || fail.Code != contract.CodeValidation {
				t.Fatalf("validation=%v", fail)
			}
			calls := 0
			view, fail, unknown := Dispatch(m, func(string, string, []byte) Page { calls++; return okPage(`{}`) })
			if calls != 0 || unknown || len(view) != 0 || fail == nil || fail.Code != contract.CodeValidation {
				t.Fatalf("calls=%d view=%s fail=%v unknown=%v", calls, view, fail, unknown)
			}
		})
	}
	items := make([]map[string]any, 101)
	for i := range items {
		items[i] = map[string]any{"product_id": i + 1, "offer_id": fmt.Sprint(i), "action_price": "1", "currency_code": "RUB", "stock": 0}
	}
	raw, _ := json.Marshal(map[string]any{"action_id": 7, "action_type": "PROMOCODE", "items": items})
	if validateJoin(raw) == nil {
		t.Fatal("accepted more than 100 promotion items")
	}
}

func TestPromotionUpdateReceiptsRequireCompleteUniqueMembership(t *testing.T) {
	for _, tc := range []struct {
		name, body string
	}{
		{"empty object", `{}`},
		{"bad JSON", `{`},
		{"legacy success", `{"result":true}`},
		{"empty arrays", `{"active_product_ids":[],"deactivated_product_ids":[],"rejected":[],"warnings":[]}`},
		{"missing warnings", `{"active_product_ids":[41,42],"deactivated_product_ids":[],"rejected":[]}`},
		{"null warnings", `{"active_product_ids":[41,42],"deactivated_product_ids":[],"rejected":[],"warnings":null}`},
		{"null state list", `{"active_product_ids":[41,42],"deactivated_product_ids":null,"rejected":[],"warnings":[]}`},
		{"missing product", `{"active_product_ids":[41],"deactivated_product_ids":[],"rejected":[],"warnings":[]}`},
		{"foreign product", `{"active_product_ids":[41,99],"deactivated_product_ids":[],"rejected":[],"warnings":[]}`},
		{"duplicate state", `{"active_product_ids":[41,41,42],"deactivated_product_ids":[],"rejected":[],"warnings":[]}`},
		{"conflicting state", `{"active_product_ids":[41,42],"deactivated_product_ids":[41],"rejected":[],"warnings":[]}`},
		{"conflicting rejection", `{"active_product_ids":[41,42],"deactivated_product_ids":[],"rejected":[{"product_id":41,"reason":"rejected"}],"warnings":[]}`},
		{"rejection missing ID", `{"active_product_ids":[41],"deactivated_product_ids":[],"rejected":[{"reason":"rejected"}],"warnings":[]}`},
		{"foreign warning", `{"active_product_ids":[41],"deactivated_product_ids":[42],"rejected":[],"warnings":[{"product_id":99,"reason":"warning"}]}`},
		{"duplicate warning", `{"active_product_ids":[41],"deactivated_product_ids":[42],"rejected":[],"warnings":[{"product_id":42,"reason":"warning"},{"product_id":42,"reason":"warning"}]}`},
		{"warning on active", `{"active_product_ids":[41,42],"deactivated_product_ids":[],"rejected":[],"warnings":[{"product_id":41,"reason":"removed"}]}`},
		{"fractional ID", `{"active_product_ids":[41,42.1],"deactivated_product_ids":[],"rejected":[],"warnings":[]}`},
		{"exponent ID", `{"active_product_ids":[41,4.2e1],"deactivated_product_ids":[],"rejected":[],"warnings":[]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := promotionMutation("promotion_join", `{"action_id":7,"action_type":"ELASTIC_BOOSTING","items":[{"product_id":41,"offer_id":"a","action_price":"1","currency_code":"RUB","stock":0},{"product_id":42,"offer_id":"b","action_price":"1","currency_code":"RUB","stock":0}]}`)
			calls := 0
			view, fail, unknown := Dispatch(m, func(string, string, []byte) Page { calls++; return okPage(tc.body) })
			if calls != 1 || !unknown || fail == nil || fail.Code != contract.CodeSellerUnknown || len(view) != 0 {
				t.Fatalf("calls=%d view=%s fail=%v unknown=%v", calls, view, fail, unknown)
			}
		})
	}
}

func TestPromotionUpdateReceiptsKeepEachOutcomeAndWarning(t *testing.T) {
	for _, joining := range []bool{true, false} {
		items, ok := promotionUpdateResults([]int64{41, 42, 43}, `{"active_product_ids":["41"],"deactivated_product_ids":[43],"rejected":[{"product_id":42,"reason":"price rejected"}],"warnings":[{"product_id":43,"reason":"above limit"}]}`, joining)
		if !ok || len(items) != 3 || items[0].Identity != "41" || items[1].Identity != "42" || items[2].Identity != "43" || items[0].Succeeded != joining || items[1].Succeeded || items[2].Succeeded == joining || !strings.Contains(items[1].Message, "price rejected") || !strings.Contains(items[2].Message, "above limit") {
			t.Fatalf("joining=%v items=%+v ok=%v", joining, items, ok)
		}
	}
}

func TestPromotionDeactivateReceiptsRequireEveryRequestedProduct(t *testing.T) {
	for _, body := range []string{`{}`, `{`, `{"result":true}`, `{"product_ids":null}`, `{"product_ids":[]}`, `{"product_ids":[41]}`, `{"product_ids":[41,41]}`, `{"product_ids":[41,99]}`, `{"product_ids":[41,42.1]}`} {
		m := promotionMutation("promotion_leave", `{"action_id":7,"action_type":"PROMOCODE","product_ids":[41,42]}`)
		view, fail, unknown := Dispatch(m, func(string, string, []byte) Page { return okPage(body) })
		if !unknown || fail == nil || fail.Code != contract.CodeSellerUnknown || len(view) != 0 {
			t.Fatalf("body=%s view=%s fail=%v unknown=%v", body, view, fail, unknown)
		}
	}
}

func TestPromotionOnlySettlesOfficial200OrExplicitHTTPRejection(t *testing.T) {
	for _, m := range []Mutation{
		promotionMutation("promotion_join", `{"action_id":7,"action_type":"PROMOCODE","items":[{"product_id":41,"offer_id":"a","action_price":"1","currency_code":"RUB","stock":0}]}`),
		promotionMutation("promotion_leave", `{"action_id":7,"action_type":"PROMOCODE","product_ids":[41]}`),
		promotionMutation("promotion_leave", `{"action_id":7,"action_type":"ELASTIC_BOOSTING","product_ids":[41],"exit_prices":[{"product_id":41,"exit_price":"1","currency_code":"RUB"}]}`),
	} {
		for _, status := range []int{0, 201, 204, 302, 400, 403, 429, 500} {
			calls := 0
			view, fail, unknown := Dispatch(m, func(string, string, []byte) Page {
				calls++
				return Page{Status: status, Body: `{"product_ids":[41],"active_product_ids":[41],"deactivated_product_ids":[],"rejected":[],"warnings":[]}`}
			})
			wantUnknown := status != 400 && status != 403
			if calls != 1 || fail == nil || unknown != wantUnknown || len(view) != 0 || wantUnknown && fail.Code != contract.CodeSellerUnknown {
				t.Fatalf("kind=%s status=%d calls=%d view=%s fail=%v unknown=%v", m.Kind, status, calls, view, fail, unknown)
			}
		}
		_, fail, unknown := Dispatch(m, func(string, string, []byte) Page {
			return Page{Status: 200, Body: `{}`, Err: errors.New("response interrupted")}
		})
		if !unknown || fail == nil || fail.Code != contract.CodeSellerUnknown {
			t.Fatal("transport failure was settled")
		}
	}
}
