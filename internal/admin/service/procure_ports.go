package service

import (
	"context"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// ProcurePort is the procurement persistence seam.
type ProcurePort interface {
	List(ctx context.Context) ([]domain.WorkItem, error)
	Claim(ctx context.Context, actor domain.Actor, in domain.ClaimInput, procurementID, operationID string, now int64) (domain.WorkItem, error)
	Dispatch(ctx context.Context, actor domain.Actor, id string, now int64) (domain.WorkItem, error)
	Receipt(ctx context.Context, actor domain.Actor, id string, in domain.ReceiptInput, now int64) (domain.WorkItem, error)
	Refund(ctx context.Context, actor domain.Actor, orderID string, now int64) (string, int64, error)
}

// ProcureOptions is the clock and id source.
type ProcureOptions struct {
	Now   func() time.Time
	NewID func() string
}
