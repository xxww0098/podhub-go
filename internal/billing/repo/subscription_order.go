package billingrepo

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
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
		sub, err := LockSubscription(ctx, tx, orgID)
		if err != nil {
			return err
		}
		q, err := claimQuote(ctx, tx, orgID, quoteID, sub.Revision, now)
		if err != nil {
			return err
		}
		if q.Payload.Quote.FreeOnly || q.Payload.Quote.AmountCents <= 0 {
			return quoteFailure(domain.CodeValidation, "免费续费配置请显式确认，无需订单")
		}
		if err = checkPending(ctx, tx, orgID, false, now); err != nil {
			return err
		}
		snapshot, err := json.Marshal(q.Payload)
		if err != nil {
			return err
		}
		priced := q.Payload.Quote

		if err := tx.QueryRow(ctx, `
			INSERT INTO payment_orders
			    (public_id, org_id, product, plan, months, amount_cents, currency, provider,
			     status, created_by_user_id, created_at, updated_at,
			     subscription_snapshot, payment_deadline_at, purchase_agreement, quote_id)
			VALUES ($1, $2, 'subscription', $3, $4, $5, $6, $7, 'pending', $8, $9, $9, $10, $11, $12, $13)
			RETURNING id`,
			publicID, orgID, priced.PlanKey, priced.Months, priced.AmountCents, currency, provider,
			userID, now, snapshot, now.Add(PaymentWindow), json.RawMessage(agreement), q.ID).Scan(&orderID); err != nil {
			return err
		}
		if priced.CouponCode != "" {
			var claimed bool
			if err = tx.QueryRow(ctx, `SELECT public.billing_coupon_consume($1,$2,$3)`, priced.CouponCode, priced.CouponPercent, now).Scan(&claimed); err != nil {
				return err
			}
			if !claimed {
				return couponInvalid()
			}
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
		return tx.QueryRow(ctx, `SELECT public.billing_reap_subscription_orders($1)`, now).Scan(&closed)
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
	var payload quotePayload
	if len(order.SubscriptionSnapshot) == 0 {
		return errors.New("subscription order without snapshot")
	}
	if err := json.Unmarshal(order.SubscriptionSnapshot, &payload); err != nil {
		return err
	}
	sub, err := LockSubscription(ctx, tx, order.OrgID)
	if err != nil {
		return err
	}
	var fulfilled bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM subscription_events WHERE order_id=$1)`, order.ID).Scan(&fulfilled); err != nil {
		return err
	}
	if fulfilled {
		return nil
	}
	if err = sub.loadPeriods(ctx, tx, now); err != nil {
		return err
	}
	q := payload.Quote
	start, end := q.TermStart, q.TermEnd
	switch q.Action {
	case domain.ActionSubscribe, domain.ActionRenew:
		anchor := now
		start = now
		if sub.TermEnd != nil && sub.TermEnd.After(now) {
			start = *sub.TermEnd
			if sub.Anchor != nil {
				anchor = *sub.Anchor
			}
		}
		end = domain.AnchoredEnd(anchor, start, q.Months)
		p := payload.Period
		p.Start = start
		p.End = end
		if err = insertPeriod(ctx, tx, order.OrgID, order.ID, p); err != nil {
			return err
		}
		// The paid end and the current capacity boundary are separate facts.
		if _, err = tx.Exec(ctx, `UPDATE subscriptions SET status='active',term_start=CASE WHEN term_end>$2 THEN term_start ELSE $2 END,
   term_end=$3,billing_anchor=$4,plan_key=CASE WHEN term_end>$2 THEN plan_key ELSE $5 END,
   stores=CASE WHEN term_end>$2 THEN stores ELSE $6 END WHERE org_id=$1`,
			order.OrgID, start, end, anchor, q.PlanKey, q.Stores); err != nil {
			return err
		}
	case domain.ActionChange:
		cat, err := Catalog(ctx, tx)
		if err != nil {
			return err
		}
		// Replay the quoted upgrade at the unit prices the quote froze, so a
		// catalogue edit between preview and payment cannot change the result.
		target := cat.Plans[q.PlanKey]
		target.StoreMonthlyCents = payload.Period.StoreMonthlyCents
		cat.Plans[q.PlanKey] = target
		periods, err := quotedChangePeriods(payload.ChangePeriods, sub.Periods, now)
		if err != nil {
			return err
		}
		applied := false
		for _, p := range periods {
			// Split the running interval so historical authorizations retain their purchased capacity.
			if p.Start.Before(now) {
				if _, err = tx.Exec(ctx, `UPDATE subscription_periods SET ends_at=$3 WHERE org_id=$1 AND id=$2`, order.OrgID, p.ID, now); err != nil {
					return err
				}
				p.Start = now
				if err = insertPeriod(ctx, tx, order.OrgID, order.ID, p); err != nil {
					return err
				}
				if err = tx.QueryRow(ctx, `SELECT id FROM subscription_periods WHERE org_id=$1 AND starts_at=$2`, order.OrgID, now).Scan(&p.ID); err != nil {
					return err
				}
			}
			upgraded, err := cat.Upgrade(p, domain.Target(payload.Request.Target))
			if err != nil {
				return err
			}
			if upgraded.PlanKey == p.PlanKey && upgraded.Stores == p.Stores {
				continue
			}
			if growth := upgraded.Stores - p.Stores; growth > 0 && p.KeepStores != nil && payload.Request.KeepStores == nil {
				var extra []string
				if err = tx.QueryRow(ctx, `SELECT COALESCE(array_agg(uuid),'{}'::uuid[]) FROM
     (SELECT uuid FROM organization_stores WHERE org_id=$1 AND deleted_at_ms IS NULL AND NOT manual_disabled
      AND NOT(uuid=ANY($2::uuid[])) ORDER BY create_order,id LIMIT $3) candidates`, order.OrgID, p.KeepStores, growth).Scan(&extra); err != nil {
					return err
				}
				upgraded.KeepStores = append(p.KeepStores, extra...)
			}

			if payload.Request.KeepStores != nil {
				upgraded.KeepStores = payload.Request.KeepStores
			}

			if _, err = tx.Exec(ctx, `UPDATE subscription_periods SET plan_key=$3,stores=$4,
    store_monthly_cents=$5,keep_store_ids=$6 WHERE org_id=$1 AND id=$2`,
				order.OrgID, p.ID, upgraded.PlanKey, upgraded.Stores,
				upgraded.StoreMonthlyCents, upgraded.KeepStores); err != nil {
				return err
			}
			applied = true
		}
		if !applied {
			if _, err = tx.Exec(ctx, `UPDATE payment_orders SET reconciliation_reason='term_shortened',fulfillment_failed_at=$2 WHERE id=$1`, order.ID, now); err != nil {
				return err
			}
		}
	default:
		return errors.New("unknown paid subscription action")
	}
	if _, err = tx.Exec(ctx, `UPDATE subscriptions SET revision=revision+1,updated_at=$2 WHERE org_id=$1`, order.OrgID, now); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO subscription_events
  (org_id,order_id,kind,effective_at,plan_from,plan_to,term_start,term_end,amount_cents,breakdown,created_at)
  VALUES($1,$2,$3,$4,$5,$6,$4,$7,$8,$9,$10)`, order.OrgID, order.ID, q.Action, start, sub.PlanKey, q.PlanKey, end, order.AmountCents, order.SubscriptionSnapshot, now); err != nil {
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

// MarkOrderPaid accepts pending orders and late subscription payments only.
func MarkOrderPaid(ctx context.Context, tx pgx.Tx, orderID int64, providerRef string, now time.Time) (bool, error) {
	// Verified late receipts still settle; canceled_at remains the cancellation history.
	tag, err := tx.Exec(ctx, `
		UPDATE payment_orders
		   SET status = 'paid', paid_at = $1, provider_ref = COALESCE($2, provider_ref),
		       reconciliation_reason = CASE WHEN status='canceled' THEN 'fulfilled_after_cancel' ELSE reconciliation_reason END,
		       qr_code = NULL, pay_url = NULL, launch_state = NULL, updated_at = $1
		 WHERE id = $3 AND (status = 'pending' OR (product IN ('subscription','wallet_topup') AND status = 'canceled'))`, now, providerRef, orderID)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() != 1 {
		return false, nil
	}
	if err := SettleFirstOrderCommission(ctx, tx, orderID, 0, "POST", "/api/billing/webhooks"); err != nil {
		return false, err
	}
	return true, nil
}

// A changed or missing priced interval needs reconciliation, never a wider entitlement.
func quotedChangePeriods(quoted, current []domain.Period, now time.Time) ([]domain.Period, error) {
	if len(quoted) == 0 {
		return nil, errors.New("change order without quoted periods")
	}
	byID := make(map[int64]domain.Period, len(current))
	for _, p := range current {
		byID[p.ID] = p
	}
	periods := make([]domain.Period, 0, len(quoted))
	for _, frozen := range quoted {
		if !frozen.End.After(now) {
			continue
		}
		p, ok := byID[frozen.ID]
		if !ok || !p.Start.Equal(frozen.Start) || !p.End.Equal(frozen.End) || p.Target != frozen.Target ||
			p.StoreMonthlyCents != frozen.StoreMonthlyCents {
			return nil, errors.New("quoted subscription period changed")
		}
		periods = append(periods, p)
	}
	return periods, nil
}

// MarkOrderNeedsReconciliation records a paid callback that could not be
// applied. The status is left alone; the reason is what the alert reads.
func MarkOrderNeedsReconciliation(ctx context.Context, tx pgx.Tx, orderID int64, reason string) error {
	_, err := tx.Exec(ctx, `
		UPDATE payment_orders SET reconciliation_reason = $1, updated_at = clock_timestamp()
		 WHERE id = $2`, reason, orderID)
	return err
}

// Keep receipt facts even when fulfillment fails, with the partial entitlement writes rolled back.
func FulfillPaidSubscription(ctx context.Context, tx pgx.Tx, order contract.Order, now time.Time) error {
	savepoint, err := tx.Begin(ctx)
	if err != nil {
		return err
	}
	if err = FulfillSubscription(ctx, savepoint, order, now); err == nil {
		return savepoint.Commit(ctx)
	}
	if rollbackErr := savepoint.Rollback(ctx); rollbackErr != nil {
		return rollbackErr
	}
	slog.Error("subscription payment needs reconciliation", "order_id", order.ID, "err", err)
	_, err = tx.Exec(ctx, `UPDATE payment_orders SET reconciliation_reason='superseded_change',fulfillment_failed_at=$2,updated_at=$2 WHERE id=$1`, order.ID, now)
	return err
}
