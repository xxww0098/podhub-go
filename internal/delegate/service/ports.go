package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
)

// Port is the repository surface this service calls. HTTP does not import it.
type Port interface {
	Accept(ctx context.Context, orgID, userID int64, dispatchID string) (string, error)
	Reject(ctx context.Context, orgID, userID int64, dispatchID, reason string) (string, error)
	Ship(ctx context.Context, orgID, userID int64, dispatchID, trackingNo, note string, nowMS int64) (string, error)
	ListDispatches(ctx context.Context, orgID, supplierUserID int64) ([]contract.DispatchView, error)
}
