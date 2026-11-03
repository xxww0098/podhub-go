package domain

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

func TestStockReceiptKeepsEachProductWarehouseOutcome(t *testing.T) {
	m := Mutation{OperationID: "00000000-0000-4000-8000-000000000001", Kind: "stock", Raw: json.RawMessage(`{"items":[{"product_id":41,"offer_id":"a","warehouse_id":7,"stock":5},{"product_id":41,"offer_id":"a","warehouse_id":8,"stock":6}]}`)}
	for _, tc := range []struct {
		name, body string
		unknown    bool
	}{
		{"mixed reordered", `{"result":[{"product_id":41,"offer_id":"a","warehouse_id":8,"updated":false,"errors":[{"code":"WAREHOUSE_NOT_FOUND","message":"warehouse is unavailable"}]},{"product_id":41,"offer_id":"a","warehouse_id":7,"updated":true,"errors":[]}]}`, false},
		{"archived failure must not restore or resend", `{"result":[{"product_id":41,"offer_id":"a","warehouse_id":7,"updated":true,"errors":[]},{"product_id":41,"offer_id":"a","warehouse_id":8,"updated":false,"errors":[{"code":"ARCHIVED_PRODUCT","message":"archived product"}]}]}`, false},
		{"empty object", `{}`, true},
		{"broken JSON", `{`, true},
		{"missing result", `{"result":[{"product_id":41,"offer_id":"a","warehouse_id":7,"updated":true,"errors":[]}]}`, true},
		{"wrong warehouse", `{"result":[{"product_id":41,"offer_id":"a","warehouse_id":7,"updated":true,"errors":[]},{"product_id":41,"offer_id":"a","warehouse_id":9,"updated":true,"errors":[]}]}`, true},
		{"wrong offer", `{"result":[{"product_id":41,"offer_id":"a","warehouse_id":7,"updated":true,"errors":[]},{"product_id":41,"offer_id":"b","warehouse_id":8,"updated":true,"errors":[]}]}`, true},
		{"duplicate result", `{"result":[{"product_id":41,"offer_id":"a","warehouse_id":7,"updated":true,"errors":[]},{"product_id":41,"offer_id":"a","warehouse_id":7,"updated":true,"errors":[]}]}`, true},
		{"missing updated", `{"result":[{"product_id":41,"offer_id":"a","warehouse_id":7,"errors":[]},{"product_id":41,"offer_id":"a","warehouse_id":8,"updated":true,"errors":[]}]}`, true},
		{"null errors", `{"result":[{"product_id":41,"offer_id":"a","warehouse_id":7,"updated":true,"errors":null},{"product_id":41,"offer_id":"a","warehouse_id":8,"updated":true,"errors":[]}]}`, true},
		{"contradictory update", `{"result":[{"product_id":41,"offer_id":"a","warehouse_id":7,"updated":true,"errors":[{"code":"FAIL"}]},{"product_id":41,"offer_id":"a","warehouse_id":8,"updated":true,"errors":[]}]}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			raw, fail, unknown := Dispatch(m, func(method, path string, body []byte) Page {
				calls++
				if method != "POST" || path != "/v2/products/stocks" {
					t.Fatalf("unexpected follow-up write: %s %s", method, path)
				}
				return Page{Status: 200, Body: tc.body}
			})
			if calls != 1 || unknown != tc.unknown {
				t.Fatalf("calls=%d unknown=%v receipt=%s fail=%+v", calls, unknown, raw, fail)
			}
			if unknown {
				if fail == nil || fail.Code != contract.CodeSellerUnknown || len(raw) != 0 {
					t.Fatalf("unverifiable receipt settled: receipt=%s fail=%+v", raw, fail)
				}
				return
			}
			var got mutationView
			if fail != nil || json.Unmarshal(raw, &got) != nil || len(got.Items) != 2 || !got.Items[0].Succeeded || got.Items[1].Succeeded || got.Items[1].Message == "" || got.Items[0].Identity == got.Items[1].Identity {
				t.Fatalf("warehouse results were lost: receipt=%s fail=%+v", raw, fail)
			}
		})
	}
}

func TestStockValidationRejectsDuplicateTargets(t *testing.T) {
	for _, tc := range []struct {
		name, items string
		valid       bool
	}{
		{"different warehouse", `[{"product_id":41,"offer_id":"a","warehouse_id":7,"stock":5},{"product_id":41,"offer_id":"a","warehouse_id":8,"stock":6}]`, true},
		{"same product warehouse", `[{"product_id":41,"offer_id":"a","warehouse_id":7,"stock":5},{"product_id":41,"offer_id":"b","warehouse_id":7,"stock":6}]`, false},
		{"same offer warehouse", `[{"product_id":41,"offer_id":"a","warehouse_id":7,"stock":5},{"product_id":42,"offer_id":" a ","warehouse_id":7,"stock":6}]`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := validateStock(json.RawMessage(`{"items":` + tc.items + `}`)); (got == nil) != tc.valid {
				t.Fatalf("valid=%v failure=%+v", tc.valid, got)
			}
		})
	}
}

func TestMutationTransportErrorsAreUnknownEvenWithResponseStatus(t *testing.T) {
	for _, page := range []Page{{Status: 302, Body: `{"result":true}`}, {Status: 200, Body: `{"result":true}`, Err: errors.New("response body interrupted")}} {
		m := Mutation{OperationID: "test", Kind: "archive", Raw: json.RawMessage(`{"product_ids":[41]}`)}
		if raw, fail, unknown := Dispatch(m, func(string, string, []byte) Page { return page }); !unknown || fail == nil || fail.Code != contract.CodeSellerUnknown || len(raw) != 0 {
			t.Fatalf("uncertain response became settled: page=%+v raw=%s fail=%+v unknown=%v", page, raw, fail, unknown)
		}
	}
}
