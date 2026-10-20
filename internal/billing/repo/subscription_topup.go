package billingrepo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

// MinTopupMicrofen is one yuan. Top-ups below it are refused rather than
// creating an order whose provider fee exceeds the amount.
const MinTopupMicrofen int64 = 1_000_000

// CreateTopupOrder opens a wallet top-up. Before this, wallet_topup orders
// existed only when an admin wrote the ledger; a free workspace had no way to
// buy AI credit.
func CreateTopupOrder(
	ctx context.Context, pool *pgxpool.Pool, orgID, userID int64,
	publicID, provider string, amountMicrofen int64, now time.Time,
) (contract.OrderBrief, error) {
	if amountMicrofen < MinTopupMicrofen {
		return contract.OrderBrief{}, &domain.QuoteError{Status: 400, Code: domain.CodeValidation,
			Message: "充值金额至少 1 元"}
	}
	if provider == "" {
		provider = "manual"
	}
	var id int64
	err := db.InTx(ctx, pool, db.App(orgID), func(tx pgx.Tx) error {
		var pending int64
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM payment_orders
			 WHERE org_id = $1 AND product = 'wallet_topup' AND status = 'pending'`, orgID).Scan(&pending); err != nil {
			return err
		}
		if pending > 0 {
			return &domain.QuoteError{Status: 409, Code: domain.CodePendingOrderExists,
				Message: "已有待支付的充值订单"}
		}
		return tx.QueryRow(ctx, `
			INSERT INTO payment_orders
			    (public_id, org_id, product, plan, months, amount_cents, currency,
			     provider, status, created_by_user_id, created_at, updated_at,
			     topup_microfen, payment_deadline_at)
			VALUES ($1, $2, 'wallet_topup', NULL, 1, $3, 'CNY', $4, 'pending', $5, $6, $6, $7, $8)
			RETURNING id`,
			publicID, orgID, amountMicrofen/1000, provider, userID, now,
			amountMicrofen, now.Add(PaymentWindow)).Scan(&id)
	})
	if err != nil {
		return contract.OrderBrief{}, err
	}
	deadline := now.Add(PaymentWindow)
	return contract.OrderBrief{ID: id, PublicID: publicID, PaymentDeadlineAt: &deadline}, nil
}
