package billingrepo

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

// RenewalLead is how long before the paid end an auto-renewal order is issued.
const RenewalLead = 72 * time.Hour

const renewalBatch = 200

// IssueDueRenewals issues one unpaid renewal order for every workspace whose
// paid service ends inside RenewalLead and has auto_renew on. It issues an
// order only. It never charges anything: the buyer picks a payment channel
// through PayAutoOrder. Returns how many orders were issued.
func IssueDueRenewals(ctx context.Context, pool *pgxpool.Pool, now time.Time) (int, error) {
	var ids []int64
	err := db.InTx(ctx, pool, db.AppRole(), func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT org_id FROM public.billing_due_renewals($1,$2,$3)`,
			now, int64(RenewalLead/time.Second), renewalBatch)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				return err
			}
			ids = append(ids, id)
		}
		return rows.Err()
	})
	if err != nil {
		return 0, err
	}
	issued := 0
	for _, id := range ids {
		ok, err := issueRenewal(ctx, pool, id, now)
		if err != nil {
			slog.Error("billing auto renewal", "org_id", id, "err", err)
			continue
		}
		if ok {
			issued++
		}
	}
	return issued, nil
}

// issueRenewal re-checks every condition under the workspace lock, because the
// candidate list was read without it.
func issueRenewal(ctx context.Context, pool *pgxpool.Pool, orgID int64, now time.Time) (bool, error) {
	issued := false
	err := db.InTx(ctx, pool, db.App(orgID), func(tx pgx.Tx) error {
		sub, err := LockSubscription(ctx, tx, orgID)
		if err != nil {
			return err
		}
		if err = sub.loadPeriods(ctx, tx, now); err != nil {
			return err
		}
		var auto bool
		if err = tx.QueryRow(ctx, `SELECT auto_renew FROM subscriptions WHERE org_id=$1`, orgID).Scan(&auto); err != nil {
			return err
		}
		if !auto || !sub.Active(now) || sub.TermEnd.Sub(now) > RenewalLead {
			return nil
		}
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM payment_orders WHERE org_id=$1 AND product='subscription'
   AND (status='pending' OR auto_term_end=$2))`, orgID, *sub.TermEnd).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return nil
		}
		// Renew what was bought last. A future period may already hold less
		// than the current one, and that is the capacity the buyer chose.
		target := domain.Target{PlanKey: sub.PlanKey, Stores: sub.Stores}
		if n := len(sub.Periods); n > 0 {
			target = sub.Periods[n-1].Target
		}
		cat, err := Catalog(ctx, tx)
		if err != nil {
			return err
		}
		q, err := domain.Quote(cat, domain.QuoteInput{Now: now, Snapshot: sub.Snapshot(),
			Action: domain.ActionRenew, Target: target, Months: 1})
		if err != nil {
			return err
		}
		req := QuoteRequest{Action: domain.ActionRenew, Target: contract.Target(target), Months: 1}
		payload := quotePayload{Revision: sub.Revision, Request: req, Quote: q, Period: domain.Period{
			Target: target, StoreMonthlyCents: cat.Plans[q.PlanKey].StoreMonthlyCents}}
		snapshot, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		var quoteID string
		if err = tx.QueryRow(ctx, `INSERT INTO subscription_quotes
   (id,org_id,revision,action,months,term_start,term_end,plan_key,stores,keep_store_ids,amount_cents,breakdown,expires_at,consumed_at,created_at,payload)
   VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,'{}',$9,$10,$11,$11,$11,$12) RETURNING id::text`,
			orgID, sub.Revision, q.Action, q.Months, q.TermStart, q.TermEnd, q.PlanKey, q.Stores, q.AmountCents,
			mustJSON(q.Breakdown), now, snapshot).Scan(&quoteID); err != nil {
			return err
		}
		var owner int64
		if err = tx.QueryRow(ctx, `SELECT owner_user_id FROM organizations WHERE id=$1`, orgID).Scan(&owner); err != nil {
			return err
		}
		publicID := "po_" + uuid.NewString()
		if _, err = tx.Exec(ctx, `
			INSERT INTO payment_orders
			    (public_id, org_id, product, plan, months, amount_cents, currency, provider,
			     status, created_by_user_id, created_at, updated_at,
			     subscription_snapshot, payment_deadline_at, quote_id, auto_term_end)
			VALUES ($1, $2, 'subscription', $3, 1, $4, 'CNY', $5, 'pending', $6, $7, $7, $8, $9, $10, $9)`,
			publicID, orgID, q.PlanKey, q.AmountCents, contract.ProviderUnselected, owner, now, snapshot,
			*sub.TermEnd, quoteID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO notifications (uuid, user_id, kind, payload, created_at)
   VALUES (gen_random_uuid(), $1, 'subscription_renewal_due', $2::jsonb, clock_timestamp())`,
			owner, mustJSON(map[string]any{"publicId": publicID, "amountCents": q.AmountCents, "termEndMs": sub.TermEnd.UnixMilli()})); err != nil {
			return err
		}
		issued = true
		return nil
	})
	return issued, err
}

// PayAutoOrder lets a buyer confirm and pick a channel for an auto-issued
// renewal. The confirming user becomes the order's creator because the
// purchase agreement must name its creator. The 15 minute payment window
// starts now, not when the order was issued.
func PayAutoOrder(ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, publicID, provider string, agreement []byte, now time.Time) (contract.OrderBrief, error) {
	var brief contract.OrderBrief
	err := db.InTx(ctx, pool, db.App(orgID), func(tx pgx.Tx) error {
		if _, err := LockSubscription(ctx, tx, orgID); err != nil {
			return err
		}
		var id int64
		var current, status string
		err := tx.QueryRow(ctx, `SELECT id, provider, status FROM payment_orders
   WHERE org_id=$1 AND public_id=$2 AND product='subscription' FOR UPDATE`, orgID, publicID).Scan(&id, &current, &status)
		if errors.Is(err, pgx.ErrNoRows) {
			return &domain.QuoteError{Status: 404, Code: "NOT_FOUND", Message: "订单不存在"}
		}
		if err != nil {
			return err
		}
		if status != "pending" || current != contract.ProviderUnselected {
			return &domain.QuoteError{Status: 409, Code: "CONFLICT", Message: "订单已选择支付方式或已结束"}
		}
		deadline := now.Add(PaymentWindow)
		if _, err = tx.Exec(ctx, `UPDATE payment_orders SET provider=$2, purchase_agreement=$3, created_by_user_id=$4,
   payment_deadline_at=$5, updated_at=$6 WHERE id=$1`, id, provider, agreement, userID, deadline, now); err != nil {
			return err
		}
		brief = contract.OrderBrief{ID: id, PublicID: publicID, PaymentDeadlineAt: &deadline}
		return nil
	})
	return brief, err
}

// SetAutoRenew switches auto-issued renewal orders on or off for a workspace.
// It does not bump the subscription revision: toggling it must not invalidate
// a quote the buyer is looking at. Turning it off closes an unpaid auto order
// but keeps its auto_term_end, so this paid end is not issued again. Turning
// it on frees that end again.
func SetAutoRenew(ctx context.Context, pool *pgxpool.Pool, orgID int64, enabled bool, now time.Time) error {
	return db.InTx(ctx, pool, db.App(orgID), func(tx pgx.Tx) error {
		if _, err := LockSubscription(ctx, tx, orgID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE subscriptions SET auto_renew=$2 WHERE org_id=$1`, orgID, enabled); err != nil {
			return err
		}
		if enabled {
			_, err := tx.Exec(ctx, `UPDATE payment_orders SET auto_term_end=NULL
   WHERE org_id=$1 AND product='subscription' AND provider='unselected' AND status='canceled'
     AND auto_term_end=(SELECT term_end FROM subscriptions WHERE org_id=$1)`, orgID)
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE payment_orders SET status='canceled', canceled_at=$2, updated_at=$2
   WHERE org_id=$1 AND product='subscription' AND provider='unselected' AND status='pending'`, orgID, now)
		return err
	})
}
