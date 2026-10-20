package billingrepo

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

// PaymentWindow is how long an unpaid subscription order blocks a new one.
// The reaper closes it after this, which frees the (org_id, product) partial
// unique index.
const PaymentWindow = 15 * time.Minute

// CreateSubscriptionOrder turns a quote into a pending order. The amount comes
// from the quote, never from the client.
func CreateSubscriptionOrder(
	ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, publicID, provider, currency string,
	quoteID string, agreement []byte, now time.Time,
) (contract.OrderBrief, error) {
	var orderID int64
	err := db.InTx(ctx, pool, db.App(orgID), func(tx pgx.Tx) error {
		q, err := claimQuote(ctx, tx, orgID, quoteID, now)
		if err != nil {
			return err
		}
		// Only one pending subscription order per workspace, matching the
		// payment_orders partial unique index. Checked here for a clean 409
		// instead of a constraint violation.
		var pending int64
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM payment_orders
			 WHERE org_id = $1 AND product = 'subscription' AND status = 'pending'`, orgID).Scan(&pending); err != nil {
			return err
		}
		if pending > 0 {
			return &domain.QuoteError{Status: 409, Code: domain.CodePendingOrderExists,
				Message: "已有待支付的订阅订单，请先完成或等待其关闭"}
		}
		snapshot, err := json.Marshal(map[string]any{
			"action":          q.Action,
			"months":          q.Months,
			"term_start":      q.TermStart.UTC().Format(time.RFC3339),
			"term_end":        q.TermEnd.UTC().Format(time.RFC3339),
			"plan_key":        q.PlanKey,
			"extra_stores":    q.ExtraStores,
			"extra_members":   q.ExtraMembers,
			"keep_store_ids":  q.KeepStores,
			"keep_member_ids": q.KeepMembers,
			"amount_cents":    q.AmountCents,
			"quote_id":        quoteID,
		})
		if err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO payment_orders
			    (public_id, org_id, plan, months, amount_cents, currency, provider,
			     status, created_by_user_id, created_at, updated_at,
			     subscription_snapshot, payment_deadline_at, purchase_agreement, quote_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $9, $10, $11, $12, $13)
			RETURNING id`,
			publicID, orgID, q.PlanKey, q.Months, q.AmountCents, currency, provider,
			userID, now, snapshot, now.Add(PaymentWindow), json.RawMessage(agreement), q.ID).Scan(&orderID); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return contract.OrderBrief{}, err
	}
	deadline := now.Add(PaymentWindow)
	return contract.OrderBrief{ID: orderID, PublicID: publicID, PaymentDeadlineAt: &deadline}, nil
}

// ReapExpiredOrders closes unpaid subscription orders whose payment window has
// passed. It runs continuously; wallet orders keep their old behavior.
func ReapExpiredOrders(ctx context.Context, pool *pgxpool.Pool, now time.Time) (int64, error) {
	var closed int64
	err := db.InTx(ctx, pool, db.AppRole(), func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE payment_orders
			   SET status = 'canceled', canceled_at = $1, updated_at = $1
			 WHERE status = 'pending'
			   AND product = 'subscription'
			   AND payment_deadline_at IS NOT NULL
			   AND payment_deadline_at <= $1`, now)
		if err != nil {
			return err
		}
		closed = tag.RowsAffected()
		return nil
	})
	return closed, err
}

// FulfillSubscription applies a paid subscription order. It is the only
// writer of a term. The caller must have already moved the order to paid with
// a status CAS; this function does not touch order status.
//
// It intentionally does not re-check the quote's revision or expiry: the
// money is in, so a stale price must not strand the order. A renewal appends
// to whatever term_end is current, so an admin or redeem-code extension is not
// overwritten.
func FulfillSubscription(ctx context.Context, tx pgx.Tx, order contract.Order, now time.Time) error {
	var snapshot struct {
		Action       string   `json:"action"`
		Months       int      `json:"months"`
		TermStart    string   `json:"term_start"`
		TermEnd      string   `json:"term_end"`
		PlanKey      string   `json:"plan_key"`
		ExtraStores  int      `json:"extra_stores"`
		ExtraMembers int      `json:"extra_members"`
		KeepStores   []string `json:"keep_store_ids"`
		KeepMembers  []int64  `json:"keep_member_ids"`
		AmountCents  int64    `json:"amount_cents"`
		QuoteID      string   `json:"quote_id"`
	}
	if len(order.SubscriptionSnapshot) == 0 {
		return errors.New("subscription order without snapshot")
	}
	if err := json.Unmarshal(order.SubscriptionSnapshot, &snapshot); err != nil {
		return err
	}
	sub, err := LockSubscription(ctx, tx, order.OrgID)
	if err != nil {
		return err
	}
	active := sub.Active(now)
	planFrom := sub.PlanKey
	var start, end time.Time
	extrasStores, extrasMembers := snapshot.ExtraStores, snapshot.ExtraMembers
	consumeSchedule := snapshot.Action == domain.ActionRenew
	switch snapshot.Action {
	case domain.ActionRenew:
		// Append to whatever term is current. If the term lapsed while the
		// payment was in flight, start a fresh one instead of charging for
		// time that is already gone.
		var current time.Time
		if sub.TermEnd != nil {
			current = *sub.TermEnd
		}
		start, end = domain.RenewTerm(current, active, now, snapshot.Months)
	case domain.ActionChange:
		if !active {
			return &domain.QuoteError{Status: 402, Code: domain.CodeRenewRequired,
				Message: "订阅已到期，无法应用容量变更"}
		}
		// A capacity change never moves the term.
		start, end = *sub.TermStart, *sub.TermEnd
	default: // subscribe
		start, end = domain.SubscribeTerm(now, snapshot.Months)
	}
	status := domain.StatusActive
	if _, err := tx.Exec(ctx, `
		UPDATE subscriptions
		   SET status = $1, plan_key = $2, term_start = $3, term_end = $4,
		       extra_stores = $5, extra_members = $6,
		       next_plan_key = CASE WHEN $7 THEN NULL ELSE next_plan_key END,
		       next_extra_stores = CASE WHEN $7 THEN 0 ELSE next_extra_stores END,
		       next_extra_members = CASE WHEN $7 THEN 0 ELSE next_extra_members END,
		       next_keep_store_ids = CASE WHEN $7 THEN '{}'::uuid[] ELSE next_keep_store_ids END,
		       next_keep_member_ids = CASE WHEN $7 THEN '{}'::bigint[] ELSE next_keep_member_ids END,
		       revision = revision + 1, updated_at = clock_timestamp()
		 WHERE org_id = $8`,
		status, snapshot.PlanKey, start, end,
		extrasStores, extrasMembers, consumeSchedule, order.OrgID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO subscription_events
		    (org_id, order_id, kind, effective_at, plan_from, plan_to,
		     stores_delta, members_delta, term_start, term_end, amount_cents, breakdown, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, clock_timestamp())`,
		order.OrgID, order.ID, snapshot.Action, now, planFrom, snapshot.PlanKey,
		snapshot.ExtraStores-sub.ExtraStores, snapshot.ExtraMembers-sub.ExtraMembers,
		start, end, order.AmountCents, order.SubscriptionSnapshot); err != nil {
		return err
	}
	_, err = ProjectSubscription(ctx, tx, order.OrgID, now)
	return err
}

// LoadOrder locks one order by public id.
func LoadOrder(ctx context.Context, tx pgx.Tx, publicID string) (contract.Order, error) {
	var o contract.Order
	err := tx.QueryRow(ctx, `
		SELECT id, org_id, public_id, product, amount_cents, currency, provider, status,
		       plan, months, subscription_snapshot, purchase_agreement, created_by_user_id
		  FROM payment_orders WHERE public_id = $1 FOR UPDATE`, publicID).Scan(
		&o.ID, &o.OrgID, &o.PublicID, &o.Product, &o.AmountCents, &o.Currency, &o.Provider,
		&o.Status, &o.Plan, &o.Months, &o.SubscriptionSnapshot, &o.PurchaseAgreement, &o.CreatedBy)
	return o, err
}

// MarkOrderPaid is the pending -> paid CAS. It returns false when the order
// was already paid or was closed by the reaper.
func MarkOrderPaid(ctx context.Context, tx pgx.Tx, orderID int64, providerRef string, now time.Time) (bool, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE payment_orders
		   SET status = 'paid', paid_at = $1, provider_ref = COALESCE($2, provider_ref),
		       qr_code = NULL, pay_url = NULL, launch_state = NULL, updated_at = $1
		 WHERE id = $3 AND status = 'pending'`, now, providerRef, orderID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// MarkOrderNeedsReconciliation records a paid callback that could not be
// applied. The status is left alone; the reason is what the alert reads.
func MarkOrderNeedsReconciliation(ctx context.Context, tx pgx.Tx, orderID int64, reason string) error {
	_, err := tx.Exec(ctx, `
		UPDATE payment_orders SET reconciliation_reason = $1, updated_at = clock_timestamp()
		 WHERE id = $2`, reason, orderID)
	return err
}
