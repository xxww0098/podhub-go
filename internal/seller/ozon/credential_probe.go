package ozon

import (
	"context"
	"net/http"

	"github.com/xxww0098/podhub-go/internal/seller/ozon/domain"
)

// ProbeRoles checks a submitted credential before custody exists. This is the
// only unbound official read; the generic egress and write port stay loopback.
func (e *Egress) ProbeRoles(ctx context.Context, clientID, apiKey string) (Reply, error) {
	if e == nil || !safeCredential(clientID) || !safeCredential(apiKey) {
		return Reply{}, ErrRefusedOrigin
	}
	if e.Loopback() {
		return e.Call(ctx, http.MethodPost, "/v1/roles", []byte(`{}`), false, true, clientID, apiKey)
	}
	if e.base != domain.ProductionBaseURL {
		return Reply{}, ErrRefusedOrigin
	}
	p := officialPort{clientID: clientID, apiKey: apiKey, client: e.officialClient(), writesDisabled: true, e: e}
	status, body, err := p.call(ctx, "/v1/roles", []byte(`{}`))
	return Reply{Status: status, Body: body}, err
}
