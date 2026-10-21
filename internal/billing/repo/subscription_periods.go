package billingrepo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
)

func paidPeriods(ctx context.Context, tx pgx.Tx, orgID int64, now time.Time) ([]domain.Period, error) {
	rows, err := tx.Query(ctx, `SELECT id, starts_at, ends_at, plan_key, extra_stores, extra_members,
 plan_stores, plan_members, plan_monthly_cents, store_monthly_cents, member_monthly_cents,
 keep_store_ids, keep_member_ids FROM subscription_periods WHERE org_id=$1 AND ends_at>$2 ORDER BY starts_at`, orgID, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Period{}
	for rows.Next() {
		var p domain.Period
		if err := rows.Scan(&p.ID, &p.Start, &p.End, &p.PlanKey, &p.ExtraStores, &p.ExtraMembers, &p.PlanStores, &p.PlanMembers, &p.PlanMonthlyCents, &p.StoreMonthlyCents, &p.MemberMonthlyCents, &p.KeepStores, &p.KeepMembers); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Subscription) loadPeriods(ctx context.Context, tx pgx.Tx, now time.Time) error {
	periods, err := paidPeriods(ctx, tx, s.OrgID, now)
	if err != nil {
		return err
	}
	s.Periods = periods
	for _, p := range periods {
		if !p.Start.After(now) {
			s.Status = domain.StatusActive
			s.PlanKey = p.PlanKey
			s.ExtraStores = p.ExtraStores
			s.ExtraMembers = p.ExtraMembers
			s.CurrentEnd = &p.End
			s.CurrentStart = &p.Start
			return nil
		}
	}
	if s.Status != domain.StatusFree {
		s.Status = domain.StatusExpired
	}
	return nil
}

func insertPeriod(ctx context.Context, tx pgx.Tx, orgID, orderID int64, p domain.Period) error {
	_, err := tx.Exec(ctx, `INSERT INTO subscription_periods
 (org_id,starts_at,ends_at,plan_key,plan_stores,plan_members,plan_monthly_cents,store_monthly_cents,member_monthly_cents,
 extra_stores,extra_members,keep_store_ids,keep_member_ids,order_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
		orgID, p.Start, p.End, p.PlanKey, p.PlanStores, p.PlanMembers, p.PlanMonthlyCents, p.StoreMonthlyCents, p.MemberMonthlyCents,
		p.ExtraStores, p.ExtraMembers, p.KeepStores, p.KeepMembers, orderID)
	return err
}
