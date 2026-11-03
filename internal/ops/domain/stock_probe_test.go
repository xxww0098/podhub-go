package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestStockProbeComparesPresentAtTheRequestedWarehouse(t *testing.T) {
	request := []byte(`{"kind":"stock","items":[
		{"sku":42,"warehouse_id":8,"stock":0},
		{"sku":41,"warehouse_id":7,"stock":1}
	]}`)
	for _, tc := range []struct {
		name, reply, verdict string
	}{
		{"applied", `{"products":[
			{"sku":41,"warehouse_id":7,"present":1,"reserved":0},
			{"sku":42,"warehouse_id":8,"present":0,"reserved":0}
		],"has_next":false}`, "applied"},
		{"different", `{"products":[
			{"sku":41,"warehouse_id":7,"present":0,"reserved":0},
			{"sku":42,"warehouse_id":8,"present":0,"reserved":0}
		],"has_next":false}`, "contradicted"},
		{"missing warehouse", `{"products":[
			{"sku":41,"warehouse_id":9,"present":1,"reserved":0},
			{"sku":42,"warehouse_id":8,"present":0,"reserved":0}
		],"has_next":false}`, "indeterminate"},
		{"duplicate target", `{"products":[
			{"sku":41,"warehouse_id":7,"present":1},
			{"sku":41,"warehouse_id":7,"present":1},
			{"sku":42,"warehouse_id":8,"present":0}
		],"has_next":false}`, "indeterminate"},
		{"missing present", `{"products":[
			{"sku":41,"warehouse_id":7,"reserved":0},
			{"sku":42,"warehouse_id":8,"present":0}
		],"has_next":false}`, "indeterminate"},
		{"null present", `{"products":[
			{"sku":41,"warehouse_id":7,"present":null},
			{"sku":42,"warehouse_id":8,"present":0}
		],"has_next":false}`, "indeterminate"},
		{"negative present", `{"products":[
			{"sku":41,"warehouse_id":7,"present":-1},
			{"sku":42,"warehouse_id":8,"present":0}
		],"has_next":false}`, "indeterminate"},
		{"string present", `{"products":[
			{"sku":41,"warehouse_id":7,"present":"1"},
			{"sku":42,"warehouse_id":8,"present":0}
		],"has_next":false}`, "indeterminate"},
		{"truncated page", `{"products":[
			{"sku":41,"warehouse_id":7,"present":1},
			{"sku":42,"warehouse_id":8,"present":0}
		],"has_next":true,"cursor":""}`, "indeterminate"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			kind, summary := Observe("product_mutation", request, func(method, path string, body []byte) Page {
				if method != "POST" || path != warehouseStockPath {
					t.Fatalf("unexpected probe %s %s", method, path)
				}
				var sent struct {
					SKU []string `json:"sku"`
				}
				if json.Unmarshal(body, &sent) != nil || len(sent.SKU) != 2 || sent.SKU[0] != "41" || sent.SKU[1] != "42" {
					t.Fatalf("unbounded stock read %s", body)
				}
				return okPage(tc.reply)
			}, nil)
			if kind != tc.verdict {
				t.Fatalf("kind=%s summary=%s", kind, summary)
			}
			if kind == "contradicted" {
				if Decide(kind, 0, nil, summary).State != "result_unknown" {
					t.Fatal("one mismatch must not release the target")
				}
				last, _ := json.Marshal(summary)
				if Decide(kind, 1, last, summary).State != "conflict" {
					t.Fatal("two matching observations must release the target")
				}
			}
		})
	}
}

func TestStockProbeFollowsTheReadbackPages(t *testing.T) {
	request := []byte(`{"kind":"stock","items":[
		{"sku":41,"warehouse_id":7,"stock":1},
		{"sku":42,"warehouse_id":8,"stock":0}
	]}`)
	calls := 0
	kind, summary := Observe("product_mutation", request, func(_, path string, body []byte) Page {
		if path != warehouseStockPath {
			t.Fatalf("unexpected probe %s", path)
		}
		calls++
		switch calls {
		case 1:
			if strings.Contains(string(body), "cursor") {
				t.Fatalf("first page carried a cursor: %s", body)
			}
			return okPage(`{"products":[{"sku":41,"warehouse_id":7,"present":1}],"has_next":true,"cursor":"next"}`)
		case 2:
			if !strings.Contains(string(body), `"cursor":"next"`) {
				t.Fatalf("second page missed the cursor: %s", body)
			}
			return okPage(`{"products":[{"sku":42,"warehouse_id":8,"present":0}],"has_next":false,"cursor":""}`)
		default:
			t.Fatal("probe read past the last page")
			return Page{}
		}
	}, nil)
	if calls != 2 || kind != "applied" || !strings.Contains(summary, "请求=1 当前=1") {
		t.Fatalf("calls=%d kind=%s summary=%s", calls, kind, summary)
	}
}

func TestStockProbeRequiresTargetIdentityAndReads(t *testing.T) {
	kind, summary := Observe("product_mutation", []byte(`{"kind":"stock","items":[]}`), func(_, _ string, _ []byte) Page {
		t.Fatal("empty target must not read")
		return Page{}
	}, nil)
	if kind != "indeterminate" || !strings.Contains(summary, "无法解析") {
		t.Fatalf("empty target: %s %s", kind, summary)
	}
	for _, request := range []string{
		`{"kind":"stock","items":[{"sku":0,"warehouse_id":7,"stock":1}]}`,
		`{"kind":"stock","items":[{"sku":41,"warehouse_id":0,"stock":1}]}`,
	} {
		kind, summary := Observe("product_mutation", []byte(request), func(_, _ string, _ []byte) Page {
			t.Fatal("invalid target must not read")
			return Page{}
		}, nil)
		if kind != "indeterminate" || !strings.Contains(summary, "SKU 或仓库") {
			t.Fatalf("request=%s kind=%s summary=%s", request, kind, summary)
		}
	}
	kind, summary = Observe("product_mutation", []byte(`{"kind":"stock","items":[{"sku":41,"warehouse_id":7,"stock":1}]}`), func(_, _ string, _ []byte) Page {
		return Page{Err: errors.New("synthetic transport failure")}
	}, nil)
	if kind != "indeterminate" || !strings.Contains(summary, "传输中断") {
		t.Fatalf("transport failure: %s %s", kind, summary)
	}
}
