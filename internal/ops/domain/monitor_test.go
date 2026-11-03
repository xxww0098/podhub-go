package domain

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

func TestMonitorPricesCurrentRootItemsAndCursor(t *testing.T) {
	calls := 0
	rows, message := loadPrices(func(method, path string, body []byte) Page {
		calls++
		var request struct{ Cursor string }
		if json.Unmarshal(body, &request) != nil || method != "POST" || path != pricesPath {
			t.Fatalf("unexpected request: %s %s %s", method, path, body)
		}
		if calls == 1 {
			if request.Cursor != "" {
				t.Fatalf("first cursor: %q", request.Cursor)
			}
			return okPage(`{"items":[{"product_id":41,"offer_id":"FIXTURE-41","price":{"price":100,"marketing_seller_price":90,"currency_code":"RUB"},"marketing_actions":{"actions":[{"title":"Fixture sale"}]}}],"cursor":"next-price","total_items":2}`)
		}
		if calls != 2 || request.Cursor != "next-price" {
			t.Fatalf("continuation %d: %s", calls, body)
		}
		return okPage(`{"items":[{"product_id":42,"offer_id":"FIXTURE-42","price":{"price":200,"currency_code":"RUB"}}],"cursor":"","total_items":2}`)
	})
	if message != "" || calls != 2 || len(rows) != 2 || rows[41].Price != 100 || rows[41].Marketing != 90 || rows[41].Currency != "RUB" || rows[41].Title != "Fixture sale" || rows[42].Price != 200 {
		t.Fatalf("prices=%+v calls=%d message=%q", rows, calls, message)
	}
}

func TestMonitorStocksCurrentRootItemsAndCursor(t *testing.T) {
	calls := 0
	rows, message := loadStocks(func(method, path string, body []byte) Page {
		calls++
		if method != "POST" || path != stocksPath {
			t.Fatalf("unexpected request: %s %s", method, path)
		}
		if calls == 1 {
			return okPage(`{"items":[{"product_id":41,"offer_id":"FIXTURE-41","stocks":[{"present":7,"reserved":2,"type":"fbs"},{"present":3,"reserved":1,"type":"fbo"}]}],"cursor":"next-stock","total_items":2}`)
		}
		if calls != 2 || !strings.Contains(string(body), `"cursor":"next-stock"`) {
			t.Fatalf("continuation %d: %s", calls, body)
		}
		return okPage(`{"items":[{"product_id":42,"offer_id":"FIXTURE-42","stocks":[]}],"cursor":"","total_items":2}`)
	})
	if message != "" || calls != 2 || len(rows) != 2 || rows[41].Present != 10 || rows[41].Reserved != 3 || rows[42].Present != 0 {
		t.Fatalf("stocks=%+v calls=%d message=%q", rows, calls, message)
	}
}

func TestMonitorPriceStockReadsDistinguishEmptyAndFailedResponses(t *testing.T) {
	for _, tc := range []struct {
		name string
		page Page
		fail bool
	}{
		{"empty", okPage(`{"items":[],"cursor":"","total_items":0}`), false},
		{"denied", Page{Status: 403, Body: `{"code":7,"message":"permission denied"}`}, true},
		{"rate limited", Page{Status: 429, Body: `{"code":8,"message":"too many requests"}`}, true},
		{"transport", Page{Err: contract.ErrUnreachable}, true},
		{"error with 200", okPage(`{"code":13,"message":"service unavailable"}`), true},
		{"legacy wrapper", okPage(`{"result":{"items":[]}}`), true},
		{"invalid JSON", okPage(`not json`), true},
		{"null items", okPage(`{"items":null}`), true},
		{"object items", okPage(`{"items":{}}`), true},
		{"null row", okPage(`{"items":[null]}`), true},
		{"missing identity", okPage(`{"items":[{}]}`), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fetch := func(_, _ string, _ []byte) Page { return tc.page }
			prices, priceMessage := loadPrices(fetch)
			stocks, stockMessage := loadStocks(fetch)
			if len(prices) != 0 || len(stocks) != 0 || (priceMessage != "") != tc.fail || (stockMessage != "") != tc.fail {
				t.Fatalf("prices=%v (%q) stocks=%v (%q), want failed=%v", prices, priceMessage, stocks, stockMessage, tc.fail)
			}
		})
	}
}

func TestMonitorRepeatedCursorRetainsPartialDataButReportsFailure(t *testing.T) {
	priceCalls, stockCalls := 0, 0
	prices, priceMessage := loadPrices(func(_, _ string, _ []byte) Page {
		priceCalls++
		return okPage(`{"items":[{"product_id":41,"price":{"price":100}}],"cursor":"repeat"}`)
	})
	stocks, stockMessage := loadStocks(func(_, _ string, _ []byte) Page {
		stockCalls++
		return okPage(`{"items":[{"product_id":41,"stocks":[{"present":1,"reserved":0}]}],"cursor":"repeat"}`)
	})
	if len(prices) != 1 || len(stocks) != 1 || priceMessage == "" || stockMessage == "" || priceCalls != 2 || stockCalls != 2 {
		t.Fatalf("prices=%v (%q, %d) stocks=%v (%q, %d)", prices, priceMessage, priceCalls, stocks, stockMessage, stockCalls)
	}
}

func TestMonitorPageBoundReportsIncompleteReads(t *testing.T) {
	for _, tc := range []struct {
		name string
		read func(Fetch) string
	}{
		{"prices", func(fetch Fetch) string { _, message := loadPrices(fetch); return message }},
		{"stocks", func(fetch Fetch) string { _, message := loadStocks(fetch); return message }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			message := tc.read(func(_, _ string, _ []byte) Page {
				calls++
				return okPage(`{"items":[],"cursor":"` + strconv.Itoa(calls) + `"}`)
			})
			if calls != maxProductPages || !strings.Contains(message, "超过安全上限") {
				t.Fatalf("calls=%d message=%q", calls, message)
			}
		})
	}
}

func TestDeleteReadbackRequiresAValidRosterBeforeConfirmingAbsence(t *testing.T) {
	for _, body := range []string{`not json`, `{}`, `{"message":"service unavailable"}`, `{"result":{"items":null}}`, `{"result":{"items":{}}}`} {
		state, note := Observe("product_mutation", []byte(`{"kind":"delete","offer_ids":["FIXTURE-41"]}`), func(_, _ string, _ []byte) Page { return okPage(body) }, nil)
		if state != "indeterminate" || !strings.Contains(note, "响应无效") {
			t.Fatalf("body=%s state=%s note=%q", body, state, note)
		}
	}
	state, _ := Observe("product_mutation", []byte(`{"kind":"delete","offer_ids":["FIXTURE-41"]}`), func(_, _ string, _ []byte) Page { return okPage(`{"result":{"items":[],"last_id":""}}`) }, nil)
	if state != "applied_by_absence" {
		t.Fatalf("valid empty roster: %s", state)
	}
}

func TestStockReadbackRequiresCurrentProductsArray(t *testing.T) {
	request := []byte(`{"kind":"stock","items":[{"sku":41,"warehouse_id":7,"stock":1}]}`)
	for _, body := range []string{`not json`, `{}`, `{"result":[]}`, `{"products":null}`} {
		state, note := Observe("product_mutation", request, func(_, _ string, _ []byte) Page { return okPage(body) }, nil)
		if state != "indeterminate" || !strings.Contains(note, "响应无效") {
			t.Fatalf("body=%s state=%s note=%q", body, state, note)
		}
	}
	state, note := Observe("product_mutation", request, func(_, _ string, _ []byte) Page { return okPage(`{"products":[],"has_next":false,"cursor":""}`) }, nil)
	if state != "indeterminate" || !strings.Contains(note, "缺少 SKU 41 在仓库 7 的记录") {
		t.Fatalf("missing target must not settle stock: %s %q", state, note)
	}
}
