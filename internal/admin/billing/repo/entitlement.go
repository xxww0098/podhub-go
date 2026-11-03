package billingrepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
)

// errBillingNotWired means the billing settle functions were not assembled.
var errBillingNotWired = errors.New("billing settle functions are not wired")

// Entitlement is the plans, orders, redeem codes, and wallet store.
// SettleFirstOrderCommission and FulfillSubscriptionOrder are the billing
// repo functions manual confirmation needs; this package may only import the
// billing contract, so internal/app passes the implementations. A nil
// function fails the confirm instead of calling through.
type Entitlement struct {
	Pool                       *pgxpool.Pool
	Now                        func() time.Time
	SettleFirstOrderCommission func(ctx context.Context, tx pgx.Tx, orderID, actorID int64, method, path string) error
	FulfillSubscriptionOrder   func(ctx context.Context, tx pgx.Tx, publicID string, now time.Time) error
}

func NewEntitlement(pool *pgxpool.Pool) *Entitlement {
	return &Entitlement{Pool: pool, Now: time.Now}
}

func (r *Entitlement) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *Entitlement) beginTx(ctx context.Context) (pgx.Tx, error) {
	return corerepo.BeginAdmin(ctx, r.Pool)
}
