package ozon

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/xxww0098/podhub-go/internal/seller/ozon/domain"
)

// SellerReadCall serves the existing business read ports after store admission.
// Call and Forward remain loopback-only; a read lane alone cannot open a path.
func (e *Egress) SellerReadCall(ctx context.Context, method, path string, body []byte, write, interactive bool, clientID, apiKey string) (Reply, error) {
	if e == nil || write || !sellerReadPath(method, path) || !safeCredential(clientID) || !safeCredential(apiKey) {
		return Reply{}, ErrRefusedOrigin
	}
	if method == http.MethodGet && len(body) != 0 || method == http.MethodPost && (len(body) > 8<<20 || !json.Valid(body)) {
		return Reply{}, ErrRefusedOrigin
	}
	if e.Loopback() {
		return e.Call(ctx, method, path, body, false, interactive, clientID, apiKey)
	}
	if e.base != domain.ProductionBaseURL {
		return Reply{}, ErrRefusedOrigin
	}
	p := officialPort{clientID: clientID, apiKey: apiKey, client: e.officialClient(), writesDisabled: true, e: e}
	status, response, err := p.exchangeMethod(ctx, method, path, body, false, interactive)
	return Reply{Status: status, Body: response}, err
}

// Exact method/path pairs keep POST read APIs separate from Seller mutations.
func sellerReadPath(method, path string) bool {
	if method == http.MethodGet {
		return path == "/v1/actions"
	}
	if method != http.MethodPost {
		return false
	}
	switch path {
	case "/v1/description-category/tree", "/v1/description-category/attribute", "/v1/description-category/attribute/values", "/v1/description-category/attribute/values/search":
		return true
	case "/v1/seller/info", "/v4/product/info/limit", "/v1/finance/balance",
		"/v3/product/list", "/v3/product/info/list", "/v5/product/info/prices", "/v4/product/info/stocks",
		"/v1/analytics/data", "/v2/warehouse/list", "/v2/delivery-method/list",
		"/v1/warehouse/operation/status", "/v2/product/info/stocks-by-warehouse/fbs",
		"/v2/actions/products", "/v2/actions/candidates",
		"/v4/posting/fbs/unfulfilled/list", "/v3/posting/fbs/get", "/v1/returns/list", "/v2/conditional-cancellation/list",
		"/v2/review/list", "/v2/review/count", "/v1/question/list", "/v1/question/count",
		"/v3/chat/list", "/v3/chat/history",
		"/v3/supply-order/list", "/v1/supply-order/status/counter", "/v3/supply-order/get",
		"/v1/supply-order/bundle", "/v1/supplier/available_warehouses", "/v2/analytics/stock_on_warehouses":
		return true
	}
	return false
}
