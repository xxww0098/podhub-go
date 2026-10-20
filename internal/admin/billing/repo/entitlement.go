package billingrepo

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// Entitlement is the plans, orders, redeem codes, and wallet store.
type Entitlement struct {
	Pool *pgxpool.Pool
	Now  func() time.Time
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
	return r.Pool.Begin(ctx)
}

func auditFailed(ctx context.Context, pool *pgxpool.Pool, publicID, reason string) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	orgID, err := scanBillingOrg(tx.QueryRow(ctx, `SELECT public.billing_payment_order_org($1)`, publicID))
	if err != nil {
		return
	}
	if err := tenantx.EnterApp(ctx, tx, orgID); err != nil {
		return
	}
	var userID, seats, amount int64
	err = tx.QueryRow(ctx, `
		SELECT created_by_user_id, COALESCE(member_seats, 0)::bigint, amount_cents
		  FROM payment_orders WHERE public_id = $1 LIMIT 1`, publicID).Scan(&userID, &seats, &amount)
	if err != nil {
		return
	}
	message, err := json.Marshal(struct {
		Reason      string `json:"reason"`
		MemberSeats int64  `json:"member_seats"`
		AmountCents int64  `json:"amount_cents"`
	}{reason, seats, amount})
	if err != nil {
		return
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_logs
		       (org_id, user_id, module, entity_type, entity_id, api_method, api_path,
		        action, status, result, message, shop_id, created_at_ms, created_at,
		        actor_kind, support_grant_id, writer_lease_id, writer_fence_token)
		VALUES ($1, $2, 'entitlement', 'payment_order', $3, 'POST', '/api/billing/webhooks',
		        'payment_order_fulfill_failed', 'failed', 'pending_retry', $4, NULL,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        clock_timestamp(), 'user', NULL, NULL, NULL)`,
		orgID, userID, publicID, string(message))
	if err != nil {
		slog.Warn("payment_order_fulfill_failed audit", "err", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		slog.Warn("payment_order_fulfill_failed audit", "err", err)
	}
}
