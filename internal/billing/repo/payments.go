package billingrepo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db"
)

// ReplayTopup, ReplayLeave, and ReplaySkip are the payment reconcile edges.
// They are local. Rust spawn_reconciliation was not in this workspace.
const (
	ReplaySkip  = "skip"
	ReplayLeave = "leave"
	ReplayTopup = "topup"
)

// DecidePaymentReplay is the pure edge. A pending wallet_topup with a positive
// amount and a ledger status of paid or succeeded replays the topup.
// Any other product stays pending. A missing ledger, a non-pending order,
// and a non-positive topup do nothing. Ledger status "paid" is local.
func DecidePaymentReplay(orderStatus, product string, topup int64, ledgerHit bool, ledgerStatus string) string {
	if orderStatus != "pending" || !ledgerHit {
		return ReplaySkip
	}
	if ledgerStatus != "paid" && ledgerStatus != "succeeded" {
		return ReplaySkip
	}
	if product != "wallet_topup" || topup <= 0 {
		return ReplayLeave
	}
	return ReplayTopup
}

// ReconcilePayments replays wallet topups whose callback ledger already says
// paid or succeeded. It does not call a payment provider. Member-seat orders
// stay pending, matching the HTTP callback. olderThan 0 selects every pending
// order. Each order is its own transaction.
func ReconcilePayments(ctx context.Context, pool *pgxpool.Pool, olderThan time.Duration) (int, error) {
	seconds := int64(olderThan / time.Second)
	if seconds < 0 {
		seconds = 0
	}
	rows, err := pool.Query(ctx, `SELECT id, public_id, org_id, product, status, topup_microfen, ledger_status FROM public.billing_replay_candidates($1)`, seconds)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	type candidate struct {
		id       int64
		publicID string
		orgID    int64
		product  string
		status   string
		topup    int64
		ledger   string
	}
	var found []candidate
	for rows.Next() {
		var row candidate
		if err := rows.Scan(&row.id, &row.publicID, &row.orgID, &row.product, &row.status, &row.topup, &row.ledger); err != nil {
			return 0, err
		}
		found = append(found, row)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	var applied int
	for _, row := range found {
		switch DecidePaymentReplay(row.status, row.product, row.topup, true, row.ledger) {
		case ReplayTopup:
			if err := replayTopup(ctx, pool, row.id, row.publicID, row.orgID, row.topup); err != nil {
				continue
			}
			applied++
		default:
		}
	}
	return applied, nil
}

func replayTopup(ctx context.Context, pool *pgxpool.Pool, id int64, publicID string, orgID, amount int64) error {
	return db.InTx(ctx, pool, db.App(orgID), func(tx pgx.Tx) error {
		var status, product string
		var topup int64
		err := tx.QueryRow(ctx, `
		SELECT status, product, COALESCE(topup_microfen, 0)
		  FROM payment_orders WHERE id = $1 FOR UPDATE`, id).Scan(&status, &product, &topup)
		if err != nil {
			return err
		}
		if DecidePaymentReplay(status, product, topup, true, "paid") != ReplayTopup || topup != amount {
			return nil
		}
		tag, err := tx.Exec(ctx, `
		UPDATE payment_orders
		   SET status = 'paid', paid_at = clock_timestamp(),
		       qr_code = NULL, pay_url = NULL, launch_state = NULL,
		       updated_at = clock_timestamp()
		 WHERE id = $1 AND status = 'pending'`, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return nil
		}
		_, err = TopupTx(ctx, tx, orgID, publicID, id, amount)
		return err
	})
}
