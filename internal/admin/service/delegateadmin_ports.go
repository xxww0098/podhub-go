package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// DelegatePort reads the staff queue. Writes stay unported.
type DelegatePort interface {
	List(ctx context.Context, q domain.OrderQuery) (domain.OrderListResponse, error)
	Get(ctx context.Context, orderID string) (domain.OrderDetailResponse, error)
}
