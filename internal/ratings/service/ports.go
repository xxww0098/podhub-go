package service

import (
	"context"
	"time"

	"github.com/xxww0098/podhub-go/internal/ratings/domain"
)

// Store is the ratings persistence port. The repo implements it.
// Cross-tenant claim and prune use the worker role. A store's rows use
// the app role.
type Store interface {
	Gate(ctx context.Context, orgID, userID int64, storeID string) (domain.Gate, error)
	Apply(ctx context.Context, orgID int64, storeID string, items []domain.Rating, now time.Time, ranks map[string]int) (domain.ApplyResult, error)
	List(ctx context.Context, orgID int64, storeID string) ([]domain.Snapshot, error)
	History(ctx context.Context, orgID int64, storeID, ratingKey string, cursor int64, limit int) ([]domain.HistoryRow, error)
	ClaimDue(ctx context.Context, now time.Time, interval time.Duration, slots, bucket, limit int) ([]domain.Due, error)
	Finish(ctx context.Context, orgID int64, storeID string, now time.Time, ok bool) error
	Prune(ctx context.Context, cutoff time.Time) (int64, error)
}

// SellerInfo posts the read-only seller info call for one store.
// A nil source means the outbound refresh path is not wired.
type SellerInfo interface {
	Post(ctx context.Context, orgID int64, storeID string) ([]byte, error)
}
