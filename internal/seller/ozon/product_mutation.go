package ozon

import (
	"context"
	"encoding/json"
	"net/http"

	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
	"github.com/xxww0098/podhub-go/internal/seller/ozon/domain"
)

// ProductMutationCall sends the product-table writes after persisted store
// admission: stock, archive, unarchive and delete. The generic egress remains
// loopback and this route cannot send other writes.
func (e *Egress) ProductMutationCall(ctx context.Context, method, path string, body []byte, write, interactive bool, clientID, apiKey string) (Reply, error) {
	if method != http.MethodPost || !write || !productMutationPath(path) {
		return Reply{}, ErrRefusedOrigin
	}
	if e == nil || e.writesDisabled {
		return Reply{}, sellercontract.ErrWritesDisabled
	}
	if !safeCredential(clientID) || !safeCredential(apiKey) || len(body) > 8<<20 || !json.Valid(body) {
		return Reply{}, ErrRefusedOrigin
	}
	if e.Loopback() {
		return e.Call(ctx, method, path, body, write, interactive, clientID, apiKey)
	}
	if e.base != domain.ProductionBaseURL {
		return Reply{}, ErrRefusedOrigin
	}
	p := officialPort{clientID: clientID, apiKey: apiKey, client: e.officialClient(), e: e}
	status, response, err := p.exchange(ctx, path, body, true, interactive)
	return Reply{Status: status, Body: response}, err
}

// Exact paths keep the product-table mutations separate from every other write.
func productMutationPath(path string) bool {
	switch path {
	case "/v2/products/stocks", "/v1/product/archive", "/v1/product/unarchive", "/v2/products/delete":
		return true
	}
	return false
}
