package ozon

import (
	"context"
	"net/http"

	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
	"github.com/xxww0098/podhub-go/internal/seller/ozon/domain"
)

// ProductPriceCall is the Ops price action after persisted store admission.
// The generic egress remains loopback and this route cannot send other writes.
func (e *Egress) ProductPriceCall(ctx context.Context, method, path string, body []byte, write, interactive bool, clientID, apiKey string) (Reply, error) {
	if method != http.MethodPost || path != "/v1/product/import/prices" || !write {
		return Reply{}, ErrRefusedOrigin
	}
	if e == nil || e.writesDisabled {
		return Reply{}, sellercontract.ErrWritesDisabled
	}
	if !safeCredential(clientID) || !safeCredential(apiKey) {
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
