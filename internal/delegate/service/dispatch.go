package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
)

// Service is the delegate use-case layer. Presign and Proxy do not dial.
type Service struct {
	port Port
}

// New binds a repository. A nil port still answers the not-ported methods.
func New(port Port) Service { return Service{port: port} }

func (s Service) Accept(ctx context.Context, orgID, userID int64, dispatchID string) (string, error) {
	if userID <= 0 {
		return "", contract.ErrForbidden
	}
	return s.port.Accept(ctx, orgID, userID, dispatchID)
}

func (s Service) Reject(ctx context.Context, orgID, userID int64, dispatchID, reason string) (string, error) {
	if userID <= 0 {
		return "", contract.ErrForbidden
	}
	return s.port.Reject(ctx, orgID, userID, dispatchID, reason)
}

func (s Service) Ship(ctx context.Context, orgID, userID int64, dispatchID, trackingNo, note string, nowMS int64) (string, error) {
	if userID <= 0 {
		return "", contract.ErrForbidden
	}
	return s.port.Ship(ctx, orgID, userID, dispatchID, trackingNo, note, nowMS)
}

func (s Service) ListDispatches(ctx context.Context, orgID, supplierUserID int64) ([]contract.DispatchView, error) {
	return s.port.ListDispatches(ctx, orgID, supplierUserID)
}

// Presign does not upload. The HTTP layer keeps the not-ported response and
// does not receive an HTTP client.
func (s Service) Presign(context.Context) error { return contract.ErrNotPorted }

// Proxy does not call Seller.
func (s Service) Proxy(context.Context) error { return contract.ErrNotPorted }
