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
		stores, members, err := liveCapacity(ctx, tx, orgID)
		if err != nil {
			return err
		}
		out = contract.View{PlanKey: domain.PlanFree, Status: sub.Status, Revision: sub.Revision, TermStart: sub.CurrentStart, TermEnd: sub.TermEnd, CurrentEnd: sub.CurrentEnd,
			Stores: contract.Capacity{Used: stores, Limit: 1}, Members: contract.Capacity{Used: members, Limit: 1}, Periods: []contract.Period{}, StoreChoices: []contract.StoreChoice{}, Plans: []contract.Plan{},
			StoreMonthlyCents: cat.StoreMonthlyCents, MemberMonthlyCents: cat.MemberMonthlyCents}
		for _, key := range []string{domain.PlanFree, domain.PlanLite, domain.PlanPro, domain.PlanMax} {
			p := cat.Plans[key]
			out.Plans = append(out.Plans, contract.Plan{Key: key, MonthlyCents: p.MonthlyCents, Stores: p.Stores, Members: p.Members})
		}
		for _, p := range sub.Periods {
			out.Periods = append(out.Periods, contract.Period{ID: p.ID, StartsAt: p.Start, EndsAt: p.End, Target: contract.Target(p.Target), Stores: p.PlanStores + p.ExtraStores, Members: p.PlanMembers + p.ExtraMembers, KeepStores: p.KeepStores, KeepMembers: p.KeepMembers})
			if !p.Start.After(now) {
				out.PlanKey = p.PlanKey
				out.Stores.Limit = p.PlanStores + p.ExtraStores
				out.Members.Limit = p.PlanMembers + p.ExtraMembers
				out.ExtraStores = p.ExtraStores
				out.ExtraMembers = p.ExtraMembers
			}
		}
		var nextStores []string
		var nextMembers []int64
		if err = tx.QueryRow(ctx, `SELECT next_keep_store_ids,next_keep_member_ids FROM subscriptions WHERE org_id=$1`, orgID).Scan(&nextStores, &nextMembers); err != nil {
			return err
		}
		target := sub.Snapshot().RenewalTarget()
		if target.PlanKey == "" || target.PlanKey == domain.PlanFree {
			target = domain.Target{PlanKey: domain.PlanLite}
		}
		p := cat.Plans[target.PlanKey]
		out.Next = &contract.NextTerm{PlanKey: target.PlanKey, ExtraStores: target.ExtraStores, ExtraMembers: target.ExtraMembers, Stores: p.Stores + target.ExtraStores, Members: p.Members + target.ExtraMembers, EffectiveAt: sub.TermEnd, KeepStores: nextStores, KeepMembers: nextMembers}
		base, err := cat.Base(target.PlanKey, target.ExtraStores, target.ExtraMembers)
		if err != nil {
			return err
		}
		out.NextRenewal = &contract.Renewal{Months: 1, AmountCents: base}
		err = tx.QueryRow(ctx, `SELECT public_id FROM payment_orders WHERE org_id=$1 AND product='subscription' AND status='pending'`, orgID).Scan(&out.PendingPublicID)
		if err != nil && err != pgx.ErrNoRows {
			return err
		}
		out.PendingOrder = out.PendingPublicID != ""
		memberRows, err := tx.Query(ctx, `SELECT id,display_name,role='owner' FROM organization_members WHERE org_id=$1 AND status='active' AND NOT manual_disabled ORDER BY (role='owner') DESC,join_order,id`, orgID)
		if err != nil {
			return err
		}
		out.MemberChoices = []contract.MemberChoice{}
		for memberRows.Next() {
			var m contract.MemberChoice
			if err = memberRows.Scan(&m.ID, &m.Name, &m.Owner); err != nil {
				memberRows.Close()
				return err
			}
			out.MemberChoices = append(out.MemberChoices, m)
		}
		err = memberRows.Err()
		memberRows.Close()
		if err != nil {
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
