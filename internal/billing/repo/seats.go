package billingrepo

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

// SweepEntitlements applies due subscription boundaries using the same projection as payments.
func SweepEntitlements(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	return ExpireDue(ctx, pool, 200, time.Now())
}
