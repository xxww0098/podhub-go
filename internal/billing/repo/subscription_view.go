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

type SubscriptionViewData = contract.View

func SubscriptionView(ctx context.Context, pool *pgxpool.Pool, orgID int64, now time.Time) (contract.View, error) {
	var out contract.View
	err := db.InTx(ctx, pool, db.App(orgID), func(tx pgx.Tx) error {
		sub, err := LockSubscription(ctx, tx, orgID)
		if err != nil {
			return err
		}
		if err = sub.loadPeriods(ctx, tx, now); err != nil {
			return err
		}
		cat, err := Catalog(ctx, tx)
		if err != nil {
			return err
		}
		stores, err := liveStoreCount(ctx, tx, orgID)
		if err != nil {
			return err
		}
		var members int
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM organization_members WHERE org_id=$1 AND status='active' AND NOT manual_disabled`, orgID).Scan(&members); err != nil {
			return err
		}
		out = contract.View{PlanKey: domain.PlanFree, Status: sub.Status, Revision: sub.Revision, TermStart: sub.CurrentStart, TermEnd: sub.TermEnd, CurrentEnd: sub.CurrentEnd,
			Stores: contract.Capacity{Used: stores, Limit: 1}, Members: contract.Capacity{Used: members, Limit: 1}, Periods: []contract.Period{}, StoreChoices: []contract.StoreChoice{}, Plans: []contract.Plan{}}
		for _, key := range []string{domain.PlanFree, domain.PlanLite, domain.PlanPro, domain.PlanMax} {
			p := cat.Plans[key]
			out.Plans = append(out.Plans, contract.Plan{Key: key, StoreMonthlyCents: p.StoreMonthlyCents})
		}
		for _, p := range sub.Periods {
			out.Periods = append(out.Periods, contract.Period{ID: p.ID, StartsAt: p.Start, EndsAt: p.End, PlanKey: p.PlanKey, Stores: p.Stores, KeepStores: p.KeepStores})
			if !p.Start.After(now) {
				out.PlanKey = p.PlanKey
			}
		}
		if err = tx.QueryRow(ctx, `SELECT stores,members FROM public.subscription_capacity($1,$2)`, orgID, now).Scan(&out.Stores.Limit, &out.Members.Limit); err != nil {
			return err
		}
		// A renewal defaults to the capacity the workspace holds right now.
		target := domain.Target{PlanKey: sub.PlanKey, Stores: sub.Stores}
		if target.PlanKey == "" || target.PlanKey == domain.PlanFree {
			target = domain.Target{PlanKey: domain.PlanLite, Stores: 1}
		}
		base, err := cat.Plans[target.PlanKey].Monthly(target.Stores)
		if err != nil {
			return err
		}
		out.NextRenewal = &contract.Renewal{Months: 1, AmountCents: base, PlanKey: target.PlanKey, Stores: target.Stores}
		err = tx.QueryRow(ctx, `SELECT public_id,provider,amount_cents,payment_deadline_at FROM payment_orders WHERE org_id=$1 AND product='subscription' AND status='pending'`, orgID).
			Scan(&out.PendingPublicID, &out.PendingProvider, &out.PendingAmountCents, &out.PendingDeadlineAt)
		if err != nil && err != pgx.ErrNoRows {
			return err
		}
		out.PendingOrder = out.PendingPublicID != ""
		out.StoreCap = domain.StoreCap
		out.Frozen = out.Stores.Limit == 0
		if err = tx.QueryRow(ctx, `SELECT auto_renew FROM subscriptions WHERE org_id=$1`, orgID).Scan(&out.AutoRenew); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT uuid::text,COALESCE(name,''),manual_disabled,public.subscription_store_allowed(org_id,uuid,$2)
   FROM organization_stores WHERE org_id=$1 AND deleted_at_ms IS NULL ORDER BY create_order,id`, orgID, now)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var s contract.StoreChoice
			if err = rows.Scan(&s.ID, &s.Name, &s.ManualDisabled, &s.Allowed); err != nil {
				return err
			}
			out.StoreChoices = append(out.StoreChoices, s)
		}
		return rows.Err()
	})
	return out, err
}
