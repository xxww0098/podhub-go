package billingrepo

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

const QuoteTTL = 15 * time.Minute

type QuoteRequest = contract.QuoteRequest
type Offered = contract.Offered
type QuoteCurrent = contract.QuoteCurrent
type QuoteTargetOut = contract.QuoteTargetOut

type quotePayload struct {
	Revision      int64            `json:"revision"`
	Request       QuoteRequest     `json:"request"`
	Quote         domain.Quotation `json:"quote"`
	Period        domain.Period    `json:"period"`
	Renewal       domain.Target    `json:"renewal"`
	UpdateRenewal bool             `json:"update_renewal"`
}

// Quote persists a preview only. ConfirmSchedule or CreateSubscriptionOrder consumes it.
func Quote(ctx context.Context, pool *pgxpool.Pool, orgID int64, req QuoteRequest, now time.Time) (Offered, error) {
	var out Offered
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
		liveStores, liveMembers, err := liveCapacity(ctx, tx, orgID)
		if err != nil {
			return err
		}
		if req.ExpectedWorkspace != "" {
			var matches bool
			if err = tx.QueryRow(ctx, `SELECT uuid::text=$2 FROM organizations WHERE id=$1`, orgID, req.ExpectedWorkspace).Scan(&matches); err != nil {
				return err
			}
			if !matches {
				return quoteFailure("WORKSPACE_MISMATCH", "工作区已切换，请在当前工作区重新预览")
			}
		}
		if req.Months == 0 {
			req.Months = 1
		}
		if req.Action == domain.ActionSchedule {
			renewal := sub.Snapshot().RenewalTarget()
			req.Target.PlanKey = renewal.PlanKey
			req.Target.ExtraMembers = renewal.ExtraMembers
			if err = tx.QueryRow(ctx, `SELECT next_keep_member_ids FROM subscriptions WHERE org_id=$1`, orgID).Scan(&req.KeepMembers); err != nil {
				return err
			}
			if len(req.KeepMembers) == 0 {
				req.KeepMembers = nil
			}
		}

		if req.Action == domain.ActionRenew {
			if err = tx.QueryRow(ctx, `SELECT next_keep_store_ids,next_keep_member_ids FROM subscriptions WHERE org_id=$1`, orgID).Scan(&req.KeepStores, &req.KeepMembers); err != nil {
				return err
			}
			if len(req.KeepStores) == 0 {
				req.KeepStores = nil
			}
			if len(req.KeepMembers) == 0 {
				req.KeepMembers = nil
			}
		}
		q, err := domain.Quote(cat, domain.QuoteInput{Now: now, Snapshot: sub.Snapshot(), Action: req.Action, Target: domain.Target(req.Target), Months: req.Months,
			KeepStores: len(req.KeepStores), KeepMembers: len(req.KeepMembers), LiveStores: liveStores, LiveMembers: liveMembers})
		if err != nil {
			return err
		}
		if req.Action == domain.ActionKeep {
			found := false
			for _, p := range sub.Periods {
				if p.ID == req.PeriodID && p.Start.After(now) {
					if req.Target != contract.Target(p.Target) {
						return quoteFailure(domain.CodeQuoteStale, "已付期间容量不可免费修改")
					}
					q.SetPlanCapacity(p.PlanStores, p.PlanMembers)
					q.TermStart = p.Start
					q.TermEnd = p.End
					found = true
					break
				}
			}
			if !found {
				return quoteFailure(domain.CodeQuoteStale, "只能修改尚未开始的已付期间保留名单")
			}
		}
		if q.ScheduleOnly || q.Action == domain.ActionRenew || req.KeepStores != nil || req.KeepMembers != nil {
			if err = validateKeep(ctx, tx, orgID, q.Stores(), q.Members(), liveStores, liveMembers, &req); err != nil {
				return err
			}
		}
		renewal := sub.Snapshot().RenewalTarget()
		update := q.ScheduleOnly && req.Action != domain.ActionKeep
		if q.Action == domain.ActionSubscribe {
			update = true
		}
		if q.Action == domain.ActionChange && !q.ScheduleOnly {
			current := domain.Target{PlanKey: sub.PlanKey, ExtraStores: sub.ExtraStores, ExtraMembers: sub.ExtraMembers}
			update = sub.NextPlanKey == nil || (renewal.ExtraStores >= current.ExtraStores && renewal.ExtraMembers >= current.ExtraMembers && cat.Plans[renewal.PlanKey].MonthlyCents >= cat.Plans[current.PlanKey].MonthlyCents)
			if req.RenewWithChange != nil {
				update = *req.RenewWithChange
			}
		}
		if update && !q.ScheduleOnly && q.Action == domain.ActionChange {
			if err = validateKeep(ctx, tx, orgID, q.Stores(), q.Members(), liveStores, liveMembers, &req); err != nil {
				return err
			}
		}

		if update {
			renewal = domain.Target(req.Target)
		}
		if q.Action == domain.ActionRenew {
			renewal = domain.Target{PlanKey: q.PlanKey, ExtraStores: q.ExtraStores, ExtraMembers: q.ExtraMembers}
		}
		plan := cat.Plans[q.PlanKey]
		payload := quotePayload{Revision: sub.Revision, Request: req, Quote: q, Renewal: renewal, UpdateRenewal: update, Period: domain.Period{
			Target: domain.Target{PlanKey: q.PlanKey, ExtraStores: q.ExtraStores, ExtraMembers: q.ExtraMembers}, PlanStores: plan.Stores, PlanMembers: plan.Members,
			PlanMonthlyCents: plan.MonthlyCents, StoreMonthlyCents: cat.StoreMonthlyCents, MemberMonthlyCents: cat.MemberMonthlyCents, KeepStores: req.KeepStores, KeepMembers: req.KeepMembers}}
		var id string
		if err = tx.QueryRow(ctx, `INSERT INTO subscription_quotes
   (id,org_id,revision,action,months,term_start,term_end,plan_key,extra_stores,extra_members,keep_store_ids,keep_member_ids,amount_cents,breakdown,expires_at,created_at,payload)
   VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'{}'::uuid[]),COALESCE($11,'{}'::bigint[]),$12,$13,$14,$15,$16) RETURNING id::text`,
			orgID, sub.Revision, q.Action, q.Months, q.TermStart, q.TermEnd, q.PlanKey, q.ExtraStores, q.ExtraMembers, req.KeepStores, req.KeepMembers, q.AmountCents, mustJSON(q.Breakdown), now.Add(QuoteTTL), now, mustJSON(payload)).Scan(&id); err != nil {
			return err
		}
		currentStores, currentMembers := 1, 1
		if sub.Active(now) {
			for _, p := range sub.Periods {
				if !p.Start.After(now) {
					currentStores = p.PlanStores + p.ExtraStores
					currentMembers = p.PlanMembers + p.ExtraMembers
					break
				}
			}
		}
		base, err := cat.Base(renewal.PlanKey, renewal.ExtraStores, renewal.ExtraMembers)
		if err != nil {
			return err
		}
		targetOut := QuoteTargetOut{PlanKey: q.PlanKey, Stores: q.Stores(), Members: q.Members()}
		if q.Action == domain.ActionChange && !q.ScheduleOnly {
			for _, p := range sub.Periods {
				if !p.Start.After(now) {
					if plan.MonthlyCents > p.PlanMonthlyCents {
						targetOut.Stores = max(plan.Stores, p.PlanStores) + max(p.ExtraStores, q.ExtraStores)
						targetOut.Members = max(plan.Members, p.PlanMembers) + max(p.ExtraMembers, q.ExtraMembers)
					} else {
						targetOut.PlanKey = p.PlanKey
						targetOut.Stores = p.PlanStores + max(p.ExtraStores, q.ExtraStores)
						targetOut.Members = p.PlanMembers + max(p.ExtraMembers, q.ExtraMembers)
					}
					break
				}
			}
		}

		out = Offered{ID: id, ExpiresAt: ptrTime(now.Add(QuoteTTL)), Revision: sub.Revision, Action: q.Action,
			Current: QuoteCurrent{PlanKey: sub.PlanKey, Stores: currentStores, Members: currentMembers, TermEnd: sub.CurrentEnd},
			Target:  targetOut, AmountCents: q.AmountCents, Breakdown: lines(q.Breakdown), ScheduleOnly: q.ScheduleOnly,
			EffectiveAt: &q.TermStart, TermEnd: &q.TermEnd, KeepStores: req.KeepStores, Renewal: contract.Target(renewal), RenewalAmountCents: base}
		return nil
	})
	return out, err
}

func liveCapacity(ctx context.Context, tx pgx.Tx, orgID int64) (int, int, error) {
	var stores, members int
	err := tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM organization_stores WHERE org_id=$1 AND deleted_at_ms IS NULL AND NOT manual_disabled),
 (SELECT count(*) FROM organization_members WHERE org_id=$1 AND status='active' AND NOT manual_disabled)`, orgID).Scan(&stores, &members)
	return stores, members, err
}

func validateKeep(ctx context.Context, tx pgx.Tx, orgID int64, stores, members, liveStores, liveMembers int, req *QuoteRequest) error {
	if liveStores > stores && len(req.KeepStores) == 0 {
		return quoteFailure(domain.CodeCapacityBelowUsage, "请选择到期后保留的店铺；只需暂停实际超出的店铺")
	}
	if liveMembers > members && len(req.KeepMembers) == 0 {
		return quoteFailure(domain.CodeCapacityBelowUsage, "请选择到期后保留的成员（包含所有者）")
	}
	if len(req.KeepStores) > stores || len(req.KeepMembers) > members {
		return quoteFailure(domain.CodeCapacityBelowUsage, "保留名单超出目标容量")
	}
	seen := map[string]bool{}
	for i, id := range req.KeepStores {
		parsed, err := uuid.Parse(id)
		if err != nil {
			return quoteFailure(domain.CodeValidation, "店铺编号无效")
		}
		id = parsed.String()
		if seen[id] {
			return quoteFailure(domain.CodeValidation, "店铺名单不能重复")
		}
		seen[id] = true
		req.KeepStores[i] = id
	}
	var n int
	if len(req.KeepStores) > 0 {
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM organization_stores WHERE org_id=$1 AND uuid=ANY($2::uuid[]) AND ($3 OR (deleted_at_ms IS NULL AND NOT manual_disabled))`, orgID, req.KeepStores, req.Action == domain.ActionRenew).Scan(&n); err != nil {
			return err
		}
		if n != len(req.KeepStores) {
			return quoteFailure(domain.CodeValidation, "保留店铺必须属于当前工作区且未手动停用")
		}
	}
	if len(req.KeepMembers) > 0 {
		seen := map[int64]bool{}
		for _, id := range req.KeepMembers {
			if seen[id] {
				return quoteFailure(domain.CodeValidation, "成员名单不能重复")
			}
			seen[id] = true
		}
		var owner bool
		if err := tx.QueryRow(ctx, `SELECT count(*),COALESCE(bool_or(role='owner'),false) FROM organization_members WHERE org_id=$1 AND id=ANY($2::bigint[]) AND status='active' AND NOT manual_disabled`, orgID, req.KeepMembers).Scan(&n, &owner); err != nil {
			return err
		}
		if n != len(req.KeepMembers) || !owner {
			return quoteFailure(domain.CodeValidation, "保留成员必须属于当前工作区且包含所有者")
		}
	}
	return nil
}

func quoteFailure(code, message string) *domain.QuoteError {
	status := 409
	if code == domain.CodeValidation {
		status = 400
	}
	return &domain.QuoteError{Status: status, Code: code, Message: message}
}
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

type storedQuote struct {
	ID       string
	Revision int64
	Payload  quotePayload
}

// Subscription must be locked before the quote to serialize concurrent admins.
func claimQuote(ctx context.Context, tx pgx.Tx, orgID int64, quoteID string, revision int64, now time.Time) (storedQuote, error) {
	var q storedQuote
	var raw []byte
	var expires time.Time
	var consumed *time.Time
	err := tx.QueryRow(ctx, `SELECT id::text,revision,payload,expires_at,consumed_at FROM subscription_quotes WHERE id=$1 AND org_id=$2 FOR UPDATE`, quoteID, orgID).Scan(&q.ID, &q.Revision, &raw, &expires, &consumed)
	if errors.Is(err, pgx.ErrNoRows) {
		return q, &domain.QuoteError{Status: 404, Code: "QUOTE_NOT_FOUND", Message: "报价不存在"}
	}
	if err != nil {
		return q, err
	}
	if consumed != nil || q.Revision != revision {
		return q, quoteFailure(domain.CodeQuoteStale, "订阅或报价已变化，请刷新后重新确认")
	}
	if !expires.After(now) {
		return q, quoteFailure(domain.CodeQuoteExpired, "报价已过期，请重新预览")
	}
	if err = json.Unmarshal(raw, &q.Payload); err != nil {
		return q, err
	}
	_, err = tx.Exec(ctx, `UPDATE subscription_quotes SET consumed_at=$2 WHERE id=$1`, q.ID, now)
	return q, err
}

// Pending external orders can only be changed after the channel confirms closure.
func checkPending(ctx context.Context, tx pgx.Tx, orgID int64, cancel bool, now time.Time) error {
	var id int64
	var provider string
	err := tx.QueryRow(ctx, `SELECT id,provider FROM payment_orders WHERE org_id=$1 AND product='subscription' AND status='pending'`, orgID).Scan(&id, &provider)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !cancel {
		return quoteFailure(domain.CodePendingOrderExists, "已有待付款订单，请明确取消旧订单后再修改")
	}
	if provider != "manual" {
		return quoteFailure("PAYMENT_PROCESSING", "支付渠道尚未确认关单，处理中；请先查询支付结果")
	}
	_, err = tx.Exec(ctx, `UPDATE payment_orders SET status='canceled',canceled_at=$2,updated_at=$2 WHERE id=$1 AND status='pending'`, id, now)
	return err
}

func ConfirmSchedule(ctx context.Context, pool *pgxpool.Pool, orgID int64, quoteID string, cancelPending bool, now time.Time) error {
	return db.InTx(ctx, pool, db.App(orgID), func(tx pgx.Tx) error {
		sub, err := LockSubscription(ctx, tx, orgID)
		if err != nil {
			return err
		}
		q, err := claimQuote(ctx, tx, orgID, quoteID, sub.Revision, now)
		if err != nil {
			return err
		}
		p := q.Payload
		if !p.Quote.ScheduleOnly {
			return quoteFailure(domain.CodeValidation, "付费变更需要创建支付订单")
		}
		if err = checkPending(ctx, tx, orgID, cancelPending, now); err != nil {
			return err
		}
		if sub.TermEnd == nil || !sub.TermEnd.After(now) {
			return quoteFailure(domain.CodeQuoteStale, "服务期已结束，请刷新")
		}
		liveStores, liveMembers, err := liveCapacity(ctx, tx, orgID)
		if err != nil {
			return err
		}
		if err = validateKeep(ctx, tx, orgID, p.Quote.Stores(), p.Quote.Members(), liveStores, liveMembers, &p.Request); err != nil {
			return err
		}
		if p.Request.Action == domain.ActionKeep {
			tag, err := tx.Exec(ctx, `UPDATE subscription_periods SET keep_store_ids=$3,keep_member_ids=$4 WHERE org_id=$1 AND id=$2 AND starts_at>$5`, orgID, p.Request.PeriodID, p.Request.KeepStores, p.Request.KeepMembers, now)
			if err != nil {
				return err
			}
			if tag.RowsAffected() != 1 {
				return quoteFailure(domain.CodeQuoteStale, "该期间已开始，请刷新")
			}
		} else {
			_, err = tx.Exec(ctx, `UPDATE subscriptions SET next_plan_key=$2,next_extra_stores=$3,next_extra_members=$4,
    next_keep_store_ids=COALESCE($5,'{}'::uuid[]),next_keep_member_ids=COALESCE($6,'{}'::bigint[]) WHERE org_id=$1`, orgID, p.Quote.PlanKey, p.Quote.ExtraStores, p.Quote.ExtraMembers, p.Request.KeepStores, p.Request.KeepMembers)
			if err != nil {
				return err
			}
		}
		if _, err = tx.Exec(ctx, `UPDATE subscriptions SET revision=revision+1,updated_at=$2 WHERE org_id=$1`, orgID, now); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO subscription_events(org_id,kind,effective_at,breakdown,created_at) VALUES($1,'schedule',$2,$3,$4)`, orgID, p.Quote.TermStart, mustJSON(p), now)
		return err
	})
}

func lines(in []domain.Line) []contract.Line {
	out := make([]contract.Line, len(in))
	for i, l := range in {
		out[i] = contract.Line{Label: l.Label, Cents: l.Cents}
	}
	return out
}
func ptrTime(t time.Time) *time.Time { return &t }
