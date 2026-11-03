package ozon

import (
	"context"
	"encoding/json"
	"net/http"

	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
	"github.com/xxww0098/podhub-go/internal/seller/ozon/domain"
)

// PromotionCall sends the two promotion writes after persisted store admission.
func (e *Egress) PromotionCall(ctx context.Context, method, path string, body []byte, write, interactive bool, clientID, apiKey string) (Reply, error) {
	if method != http.MethodPost || !write || path != "/v1/actions/products/update" && path != "/v2/actions/products/deactivate" {
		return Reply{}, ErrRefusedOrigin
	}
	if e == nil || e.writesDisabled {
		return Reply{}, sellercontract.ErrWritesDisabled
	}
	if !safeCredential(clientID) || !safeCredential(apiKey) || len(body) > 8<<20 || !json.Valid(body) {
		return Reply{}, ErrRefusedOrigin
	}
	if e.Loopback() {
		return e.Call(ctx, method, path, body, true, interactive, clientID, apiKey)
	}
	if e.base != domain.ProductionBaseURL {
		return Reply{}, ErrRefusedOrigin
	}
	p := officialPort{clientID: clientID, apiKey: apiKey, client: e.officialClient(), e: e}
	status, response, err := p.exchange(ctx, path, body, true, interactive)
	return Reply{Status: status, Body: response}, err
}
