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
	ChangePeriods []domain.Period  `json:"change_periods,omitempty"`
}

// Quote persists a preview only. ConfirmKeep or CreateSubscriptionOrder consumes it.
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
		liveStores, err := liveStoreCount(ctx, tx, orgID)
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
		if req.Action == domain.ActionRenew && req.Target.PlanKey == "" {
			req.Target = contract.Target{PlanKey: sub.PlanKey, Stores: sub.Stores}
		}
		code, couponPercent, err := couponOffer(ctx, tx, req.CouponCode, now)
		if err != nil {
			return err
		}
		req.CouponCode = code
		q, err := domain.Quote(cat, domain.QuoteInput{Now: now, Snapshot: sub.Snapshot(), Action: req.Action, Target: domain.Target(req.Target), Months: req.Months,
			KeepStores: len(req.KeepStores), LiveStores: liveStores, CouponCode: code, CouponPercent: couponPercent})
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
					q.PlanKey, q.Stores = p.PlanKey, p.Stores
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
		if q.FreeOnly || q.Action == domain.ActionRenew || q.Action == domain.ActionChange || req.KeepStores != nil {
			if err = validateKeep(ctx, tx, orgID, q.Stores, liveStores, &req); err != nil {
				return err
			}
		}
		plan := cat.Plans[q.PlanKey]
		payload := quotePayload{Revision: sub.Revision, Request: req, Quote: q, Period: domain.Period{
			Target:            domain.Target{PlanKey: q.PlanKey, Stores: q.Stores},
			StoreMonthlyCents: plan.StoreMonthlyCents, KeepStores: req.KeepStores}}
		if q.Action == domain.ActionChange {
			payload.ChangePeriods = sub.Periods
		}
		var id string
		if err = tx.QueryRow(ctx, `INSERT INTO subscription_quotes
   (id,org_id,revision,action,months,term_start,term_end,plan_key,stores,keep_store_ids,amount_cents,breakdown,expires_at,created_at,payload)
   VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'{}'::uuid[]),$10,$11,$12,$13,$14) RETURNING id::text`,
			orgID, sub.Revision, q.Action, q.Months, q.TermStart, q.TermEnd, q.PlanKey, q.Stores, req.KeepStores, q.AmountCents, mustJSON(q.Breakdown), now.Add(QuoteTTL), now, mustJSON(payload)).Scan(&id); err != nil {
			return err
		}
		var currentStores, currentMembers int
		if err = tx.QueryRow(ctx, `SELECT stores,members FROM public.subscription_capacity($1,$2)`, orgID, now).Scan(&currentStores, &currentMembers); err != nil {
			return err
		}
		targetOut := QuoteTargetOut{PlanKey: q.PlanKey, Stores: q.Stores}
		if q.Action == domain.ActionChange {
			for _, p := range sub.Periods {
				if !p.Start.After(now) {
					upgraded, uerr := cat.Upgrade(p, domain.Target(req.Target))
					if uerr != nil {
						return uerr
					}
					targetOut = QuoteTargetOut{PlanKey: upgraded.PlanKey, Stores: upgraded.Stores}
					break
				}
			}
		}

		out = Offered{ID: id, ExpiresAt: ptrTime(now.Add(QuoteTTL)), Revision: sub.Revision, Action: q.Action,
			Current: QuoteCurrent{PlanKey: sub.PlanKey, Stores: currentStores, Members: currentMembers, TermEnd: sub.CurrentEnd},
			Target:  targetOut, AmountCents: q.AmountCents, Breakdown: lines(q.Breakdown), FreeOnly: q.FreeOnly,
			EffectiveAt: &q.TermStart, TermEnd: &q.TermEnd, KeepStores: req.KeepStores}
		if q.CouponCode != "" {
			out.Coupon = &contract.AppliedCoupon{Code: q.CouponCode, DiscountPercent: q.CouponPercent, DiscountCents: q.CouponDiscountCents}
		}
		return nil
	})
	return out, err
}

func liveStoreCount(ctx context.Context, tx pgx.Tx, orgID int64) (int, error) {
	var stores int
	err := tx.QueryRow(ctx, `SELECT count(*) FROM organization_stores WHERE org_id=$1 AND deleted_at_ms IS NULL AND NOT manual_disabled`, orgID).Scan(&stores)
	return stores, err
}

func validateKeep(ctx context.Context, tx pgx.Tx, orgID int64, stores, liveStores int, req *QuoteRequest) error {
	if liveStores > stores && len(req.KeepStores) == 0 {
		return quoteFailure(domain.CodeCapacityBelowUsage, "请选择到期后保留的店铺；只需暂停实际超出的店铺")
	}
	if len(req.KeepStores) > stores {
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
	// An auto-issued renewal that has no channel yet is the system's proposal,
	// not the buyer's order. Any new configuration replaces it, and the next
	// sweep proposes again from the new capacity.
	if provider == contract.ProviderUnselected {
		_, err = tx.Exec(ctx, `UPDATE payment_orders SET status='canceled',canceled_at=$2,updated_at=$2,auto_term_end=NULL WHERE id=$1 AND status='pending'`, id, now)
		return err
	}
	if !cancel {
		return quoteFailure(domain.CodePendingOrderExists, "已有待付款订单，请明确取消旧订单后再修改")
	}
	if !contract.NoChannel(provider) {
		return quoteFailure("PAYMENT_PROCESSING", "支付渠道尚未确认关单，处理中；请先查询支付结果")
	}
	_, err = tx.Exec(ctx, `UPDATE payment_orders SET status='canceled',canceled_at=$2,updated_at=$2 WHERE id=$1 AND status='pending'`, id, now)
	return err
}

// ConfirmKeep consumes a free keep-list quote and rewrites the keep list of a
// paid period that has not started yet.
func ConfirmKeep(ctx context.Context, pool *pgxpool.Pool, orgID int64, quoteID string, cancelPending bool, now time.Time) error {
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
		if !p.Quote.FreeOnly {
			return quoteFailure(domain.CodeValidation, "付费变更需要创建支付订单")
		}
		if err = checkPending(ctx, tx, orgID, cancelPending, now); err != nil {
			return err
		}
		if sub.TermEnd == nil || !sub.TermEnd.After(now) {
			return quoteFailure(domain.CodeQuoteStale, "服务期已结束，请刷新")
		}
		liveStores, err := liveStoreCount(ctx, tx, orgID)
		if err != nil {
			return err
		}
		if err = validateKeep(ctx, tx, orgID, p.Quote.Stores, liveStores, &p.Request); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE subscription_periods SET keep_store_ids=$3 WHERE org_id=$1 AND id=$2 AND starts_at>$4`, orgID, p.Request.PeriodID, p.Request.KeepStores, now)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return quoteFailure(domain.CodeQuoteStale, "该期间已开始，请刷新")
		}
		if _, err = tx.Exec(ctx, `UPDATE subscriptions SET revision=revision+1,updated_at=$2 WHERE org_id=$1`, orgID, now); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO subscription_events(org_id,kind,effective_at,breakdown,created_at) VALUES($1,'keep',$2,$3,$4)`, orgID, p.Quote.TermStart, mustJSON(p), now)
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
