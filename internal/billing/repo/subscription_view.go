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

// SubscriptionViewData is contract.View.
type SubscriptionViewData = contract.View

// SubscriptionView reads the plan screen. It never writes.
func SubscriptionView(ctx context.Context, pool *pgxpool.Pool, orgID int64, now time.Time) (SubscriptionViewData, error) {
	var out SubscriptionViewData
	err := db.InTx(ctx, pool, db.App(orgID), func(tx pgx.Tx) error {
		sub, err := subscriptionRow(ctx, tx, orgID)
		if err != nil {
			return err
		}
		cat, err := Catalog(ctx, tx)
		if err != nil {
			return err
		}
		var usedStores, usedMembers, limitStores, limitMembers int
		if err := tx.QueryRow(ctx, `
			SELECT
			    (SELECT count(*) FROM organization_stores
			      WHERE org_id = $1 AND deleted_at_ms IS NULL AND NOT quota_suspended),
			    (SELECT count(*) FROM organization_members
			      WHERE org_id = $1 AND status = 'active' AND NOT manual_disabled AND NOT quota_suspended),
			    COALESCE((SELECT store_limit FROM organizations WHERE id = $1), 1),
			    COALESCE((SELECT seat_limit FROM organizations WHERE id = $1), 1)`,
			orgID).Scan(&usedStores, &usedMembers, &limitStores, &limitMembers); err != nil {
			return err
		}
		drain, err := DrainStart(ctx, tx, orgID)
		if err != nil {
			return err
		}
		var pending int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM payment_orders
			 WHERE org_id = $1 AND product = 'subscription' AND status = 'pending'`, orgID).Scan(&pending); err != nil {
			return err
		}
		out = SubscriptionViewData{
			PlanKey:      planKeyDisplay(sub, now),
			Status:       sub.Status,
			TermStart:    sub.TermStart,
			TermEnd:      sub.TermEnd,
			Stores:       contract.Capacity{Used: usedStores, Limit: limitStores},
			Members:      contract.Capacity{Used: usedMembers, Limit: limitMembers},
			Draining:     drain != nil,
			PendingOrder: pending > 0,
		}
		if sub.NextPlanKey != nil {
			p, ok := cat.Plans[*sub.NextPlanKey]
			if ok {
				out.Next = &contract.NextTerm{
					PlanKey: *sub.NextPlanKey,
					Stores:  p.Stores + sub.NextStores,
					Members: p.Members + sub.NextMembers,
				}
			}
		}
		if sub.Active(now) {
			target := sub.Snapshot().RenewalTarget()
			base, err := cat.Base(target.PlanKey, target.ExtraStores, target.ExtraMembers)
			if err == nil {
				out.NextRenewal = &contract.Renewal{
					Months:      1,
					AmountCents: base,
					Breakdown: []contract.Line{{
						Label: target.PlanKey + "，整月 ×1",
						Cents: base,
					}},
				}
			}
		}
		return nil
	})
	return out, err
}

func subscriptionRow(ctx context.Context, tx pgx.Tx, orgID int64) (Subscription, error) {
	var s Subscription
	err := tx.QueryRow(ctx, `
		SELECT org_id, status, plan_key, term_start, term_end,
		       extra_stores, extra_members, next_plan_key,
		       next_extra_stores, next_extra_members, revision
		  FROM subscriptions WHERE org_id = $1`, orgID).Scan(
		&s.OrgID, &s.Status, &s.PlanKey, &s.TermStart, &s.TermEnd,
		&s.ExtraStores, &s.ExtraMembers, &s.NextPlanKey,
		&s.NextStores, &s.NextMembers, &s.Revision)
	if err == pgx.ErrNoRows {
		return Subscription{}, ErrNoSubscription
	}
	return s, err
}

// planKeyDisplay shows the plan that is in force now, which is free once the
// term has lapsed even though the stored plan_key still names the paid tier.
func planKeyDisplay(s Subscription, now time.Time) string {
	if s.Active(now) {
		return s.PlanKey
	}
	return domain.PlanFree
}
