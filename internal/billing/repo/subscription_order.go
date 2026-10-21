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
		if q.Payload.Quote.ScheduleOnly || q.Payload.Quote.AmountCents <= 0 {
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
   extra_stores=CASE WHEN term_end>$2 THEN extra_stores ELSE $6 END,
   extra_members=CASE WHEN term_end>$2 THEN extra_members ELSE $7 END WHERE org_id=$1`,
			order.OrgID, start, end, anchor, q.PlanKey, q.ExtraStores, q.ExtraMembers); err != nil {
			return err
		}
	case domain.ActionChange:
		applied := false
		for _, p := range sub.Periods {
			if !p.End.After(now) {
				continue
			}
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
			upgraded := p.PlanMonthlyCents < payload.Period.PlanMonthlyCents
			stores, members := max(p.ExtraStores, q.ExtraStores), max(p.ExtraMembers, q.ExtraMembers)
			if !upgraded && stores == p.ExtraStores && members == p.ExtraMembers {
				continue
			}
			oldStores, oldMembers := p.PlanStores+p.ExtraStores, p.PlanMembers+p.ExtraMembers
			if upgraded {
				p.PlanKey = q.PlanKey
				p.PlanStores = max(p.PlanStores, payload.Period.PlanStores)
				p.PlanMembers = max(p.PlanMembers, payload.Period.PlanMembers)
				p.PlanMonthlyCents = payload.Period.PlanMonthlyCents
			}
			if growth := p.PlanStores + stores - oldStores; growth > 0 && p.KeepStores != nil && payload.Request.KeepStores == nil {
				var extra []string
				if err = tx.QueryRow(ctx, `SELECT COALESCE(array_agg(uuid),'{}'::uuid[]) FROM
     (SELECT uuid FROM organization_stores WHERE org_id=$1 AND deleted_at_ms IS NULL AND NOT manual_disabled
      AND NOT(uuid=ANY($2::uuid[])) ORDER BY create_order,id LIMIT $3) candidates`, order.OrgID, p.KeepStores, growth).Scan(&extra); err != nil {
					return err
				}
				p.KeepStores = append(p.KeepStores, extra...)
			}
			if growth := p.PlanMembers + members - oldMembers; growth > 0 && p.KeepMembers != nil && payload.Request.KeepMembers == nil {
				var extra []int64
				if err = tx.QueryRow(ctx, `SELECT COALESCE(array_agg(id),'{}'::bigint[]) FROM
     (SELECT id FROM organization_members WHERE org_id=$1 AND status='active' AND NOT manual_disabled
      AND NOT(id=ANY($2::bigint[])) ORDER BY (role='owner') DESC,join_order,id LIMIT $3) candidates`, order.OrgID, p.KeepMembers, growth).Scan(&extra); err != nil {
					return err
				}
				p.KeepMembers = append(p.KeepMembers, extra...)
			}

			if payload.Request.KeepStores != nil {
				p.KeepStores = payload.Request.KeepStores
			}
			if payload.Request.KeepMembers != nil {
				p.KeepMembers = payload.Request.KeepMembers
			}

			if _, err = tx.Exec(ctx, `UPDATE subscription_periods SET plan_key=$3,plan_stores=$4,plan_members=$5,plan_monthly_cents=$6,
    extra_stores=$7,extra_members=$8,keep_store_ids=$9,keep_member_ids=$10 WHERE org_id=$1 AND id=$2`,
				order.OrgID, p.ID, p.PlanKey, p.PlanStores, p.PlanMembers, p.PlanMonthlyCents, stores, members, p.KeepStores, p.KeepMembers); err != nil {
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
	if payload.UpdateRenewal && sub.Revision == payload.Revision {
		r := payload.Renewal
		if _, err = tx.Exec(ctx, `UPDATE subscriptions SET next_plan_key=$2,next_extra_stores=$3,next_extra_members=$4,
   next_keep_store_ids=COALESCE($5,'{}'::uuid[]),next_keep_member_ids=COALESCE($6,'{}'::bigint[]) WHERE org_id=$1`, order.OrgID, r.PlanKey, r.ExtraStores, r.ExtraMembers, payload.Request.KeepStores, payload.Request.KeepMembers); err != nil {
			return err
		}
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

// MarkOrderPaid is the pending -> paid CAS. It returns false when the order
// was already paid or was closed by the reaper.
func MarkOrderPaid(ctx context.Context, tx pgx.Tx, orderID int64, providerRef string, now time.Time) (bool, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE payment_orders
		   SET status = 'paid', paid_at = $1, provider_ref = COALESCE($2, provider_ref),
		       qr_code = NULL, pay_url = NULL, launch_state = NULL, updated_at = $1
		 WHERE id = $3 AND status IN ('pending','canceled')`, now, providerRef, orderID)
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
