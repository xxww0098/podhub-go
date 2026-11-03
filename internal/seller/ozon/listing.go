package ozon

import (
	"context"
	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
	"github.com/xxww0098/podhub-go/internal/seller/ozon/domain"
	"net/http"
	"strings"
)

type CredentialOpener func(context.Context, sellercontract.StoreBinding) (StoreScope, string, string, error)

type listingPort struct {
	e    *Egress
	open CredentialOpener
}

// NewListingTransport is an explicit production-capable assembly. New and Port
// retain their original loopback-only policy. An unbound listing port cannot send.
func NewListingTransport(e *Egress, open CredentialOpener) sellercontract.StoreTransport {
	return listingPort{e: e, open: open}
}

func (p listingPort) WritesDisabled() bool        { return p.e == nil || p.e.writesDisabled }
func (p listingPort) Ready(context.Context) error { return sellercontract.ErrNotSent }
func (p listingPort) Write(context.Context, string, []byte) (int, string, error) {
	return 0, "", sellercontract.ErrNotSent
}
func (p listingPort) Read(context.Context, string, []byte) (int, string, error) {
	return 0, "", sellercontract.ErrNotSent
}

func (p listingPort) BindStore(ctx context.Context, scope sellercontract.StoreBinding) (sellercontract.Transport, error) {
	if p.e == nil || p.open == nil {
		return nil, sellercontract.ErrNotSent
	}
	store, clientID, apiKey, err := p.open(ctx, scope)
	if err != nil || store.OrgID != scope.OrgID || (scope.StorePK != 0 && store.StorePK != scope.StorePK) || (scope.StoreUUID != "" && !strings.EqualFold(store.StoreUUID, scope.StoreUUID)) {
		return nil, sellercontract.ErrNotSent
	}
	if p.e.Loopback() {
		if _, err := newOfficialPort(store, clientID, apiKey, true); err != nil {
			return nil, err
		}
		return boundLoopbackPort{e: p.e, clientID: clientID, apiKey: apiKey, readOnly: scope.ReadOnly}, nil
	}
	port, err := newOfficialPort(store, clientID, apiKey, scope.ReadOnly || p.e.writesDisabled)
	if err != nil {
		return nil, err
	}
	port.e = p.e
	port.client = p.e.officialClient()
	return port, nil
}

type boundLoopbackPort struct {
	e                *Egress
	clientID, apiKey string
	readOnly         bool
}

func (p boundLoopbackPort) WritesDisabled() bool {
	return p.readOnly || p.e == nil || p.e.writesDisabled
}
func (p boundLoopbackPort) PhysicalAccountKey() string { return domain.PhysicalAccountKey(p.clientID) }
func (p boundLoopbackPort) Ready(context.Context) error {
	if p.WritesDisabled() || !p.e.Loopback() {
		return sellercontract.ErrNotSent
	}
	return nil
}
func (p boundLoopbackPort) Write(ctx context.Context, path string, body []byte) (int, string, error) {
	if p.WritesDisabled() || path != "/v3/product/import" {
		return 0, "", sellercontract.ErrNotSent
	}
	reply, err := p.e.Call(ctx, http.MethodPost, path, body, true, false, p.clientID, p.apiKey)
	return reply.Status, reply.Body, err
}
func (p boundLoopbackPort) Read(ctx context.Context, path string, body []byte) (int, string, error) {
	if p.e == nil || (path != "/v3/product/info/list" && path != "/v1/product/import/info" && path != "/v2/product/pictures/info") {
		return 0, "", sellercontract.ErrNotSent
	}
	reply, err := p.e.Call(ctx, http.MethodPost, path, body, false, false, p.clientID, p.apiKey)
	return reply.Status, reply.Body, err
}
