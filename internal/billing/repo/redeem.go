package billingrepo

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/billing/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

func redeemErr(status int, code, message string) error {
	return &RedeemError{Status: status, Code: code, Message: message}
}

// Redeem grants a code to the locked workspace. The caller must already be the owner.
func Redeem(ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, code, expectedWorkspace string) (RedeemResult, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return RedeemResult{}, redeemErr(400, "VALIDATION", "请输入兑换码")
	}
	expected, err := uuid.Parse(strings.TrimSpace(expectedWorkspace))
	if err != nil {
		return RedeemResult{}, redeemErr(400, "VALIDATION", "Workspace 标识无效")
	}
	var result RedeemResult
	var fnErr error
	err = db.InTx(ctx, pool, db.App(orgID), func(tx pgx.Tx) error {
		result, fnErr = redeemTx(ctx, tx, orgID, userID, code, expected)
		return fnErr
	})
	if err != nil && fnErr == nil {
		return RedeemResult{}, redeemErr(500, "INTERNAL", "兑换失败")
	}
	if err != nil {
		return RedeemResult{}, err
	}
	return result, nil
}

// redeemTx runs inside the app session. Every error it returns is a RedeemError.
func redeemTx(ctx context.Context, tx pgx.Tx, orgID, userID int64, code string, expected uuid.UUID) (RedeemResult, error) {
	var err error
	var orgUUID uuid.UUID
	var dissolved *time.Time
	// Ledger inserts take a foreign-key lock on this row before releasing the wallet.
	err = tx.QueryRow(ctx, `
		SELECT uuid, dissolved_at FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, orgID).Scan(&orgUUID, &dissolved)
	if err != nil {
		return RedeemResult{}, redeemErr(500, "INTERNAL", "兑换失败")
	}
	if orgUUID != expected {
		return RedeemResult{}, redeemErr(409, "WORKSPACE_MISMATCH", "当前 Workspace 已切换，请刷新后重试")
	}
	if dissolved != nil {
		return RedeemResult{}, redeemErr(400, "VALIDATION", "工作空间已解散")
	}
	var row struct {
		ID          int64
		WalletCents int64
		Used        bool
		ExpiresAt   *time.Time
		RevokedAt   *time.Time
		PlanKey     *string
		PlanStores  *int
		PlanMonths  *int
		PlanPrice   *int64
	}
	err = tx.QueryRow(ctx, `
		SELECT id, wallet_cents, used, expires_at, revoked_at, plan_key, plan_stores, plan_months, plan_store_monthly_cents
		  FROM public.billing_lock_redeem_code($1)`, code).Scan(&row.ID, &row.WalletCents, &row.Used, &row.ExpiresAt, &row.RevokedAt,
		&row.PlanKey, &row.PlanStores, &row.PlanMonths, &row.PlanPrice)
	if errors.Is(err, pgx.ErrNoRows) {
		return RedeemResult{}, redeemErr(400, "VALIDATION", "兑换码无效")
	}
	if err != nil {
		return RedeemResult{}, redeemErr(500, "INTERNAL", "兑换失败")
	}
	if row.Used {
		return RedeemResult{}, redeemErr(400, "VALIDATION", "兑换码已被使用")
	}
	if row.RevokedAt != nil {
		return RedeemResult{}, redeemErr(400, "VALIDATION", "兑换码已作废")
	}
	if row.ExpiresAt != nil && !row.ExpiresAt.After(time.Now()) {
		return RedeemResult{}, redeemErr(400, "VALIDATION", "兑换码已过期")
	}
	var result RedeemResult
	if row.PlanKey != nil {
		if row.PlanStores == nil || row.PlanMonths == nil || row.PlanPrice == nil {
			return RedeemResult{}, redeemErr(400, "VALIDATION", "兑换码套餐无效")
		}
		result, err = redeemPlan(ctx, tx, orgID, row.ID, *row.PlanKey, *row.PlanStores, *row.PlanMonths, *row.PlanPrice)
		if err != nil {
			return RedeemResult{}, err
		}
	} else {
		if row.WalletCents < 100 || row.WalletCents > 1_000_000 {
			return RedeemResult{}, redeemErr(400, "VALIDATION", "兑换码钱包额度无效")
		}
		if _, err = AdjustTx(ctx, tx, orgID, fmt.Sprintf("redeem:%d", row.ID), row.WalletCents*1_000_000, "兑换码充值"); err != nil {
			return RedeemResult{}, redeemErr(500, "INTERNAL", "兑换失败")
		}
		result.WalletCents = row.WalletCents
	}
	var consumed int
	err = tx.QueryRow(ctx, `SELECT public.billing_consume_redeem_code($1, $2, $3, $4)`, row.ID, userID, orgID, time.Now().UnixMilli()).Scan(&consumed)
	if err != nil {
		return RedeemResult{}, redeemErr(500, "INTERNAL", "兑换失败")
	}
	if consumed != 1 {
		return RedeemResult{}, redeemErr(400, "VALIDATION", "兑换码已被使用")
	}
	return result, nil
}

func redeemPlan(ctx context.Context, tx pgx.Tx, orgID, codeID int64, plan string, stores, months int, price int64) (RedeemResult, error) {
	now := time.Now().UTC().Truncate(time.Microsecond)
	sub, err := LockSubscription(ctx, tx, orgID)
	if err != nil {
		return RedeemResult{}, redeemErr(500, "INTERNAL", "兑换失败")
	}
	if err = checkPending(ctx, tx, orgID, false, now); err != nil {
		var refusal *domain.QuoteError
		if errors.As(err, &refusal) {
			return RedeemResult{}, redeemErr(refusal.Status, refusal.Code, refusal.Message)
		}
		return RedeemResult{}, redeemErr(500, "INTERNAL", "兑换失败")
	}
	start, anchor := now, now
	if sub.TermEnd != nil && sub.TermEnd.After(now) {
		start = *sub.TermEnd
		if sub.Anchor != nil {
			anchor = *sub.Anchor
		}
	}
	end := domain.AnchoredEnd(anchor, start, months)
	var keep []string
	var live int
	if live, err = liveStoreCount(ctx, tx, orgID); err == nil && live > stores {
		err = tx.QueryRow(ctx, `SELECT COALESCE(array_agg(uuid),'{}'::uuid[]) FROM
			(SELECT uuid FROM organization_stores WHERE org_id=$1 AND deleted_at_ms IS NULL AND NOT manual_disabled
			 ORDER BY create_order,id LIMIT $2) selected`, orgID, stores).Scan(&keep)
	}
	if err != nil {
		return RedeemResult{}, redeemErr(500, "INTERNAL", "兑换失败")
	}
	_, err = tx.Exec(ctx, `INSERT INTO subscription_periods
		(org_id,starts_at,ends_at,plan_key,stores,store_monthly_cents,keep_store_ids,redeem_code_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, orgID, start, end, plan, stores, price, keep, codeID)
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE subscriptions SET status='active',
			term_start=CASE WHEN term_end>$2 THEN term_start ELSE $3 END, term_end=$4,
			billing_anchor=$5, plan_key=CASE WHEN term_end>$2 THEN plan_key ELSE $6 END,
			stores=CASE WHEN term_end>$2 THEN stores ELSE $7 END, revision=revision+1,updated_at=$2 WHERE org_id=$1`,
			orgID, now, start, end, anchor, plan, stores)
	}
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO subscription_events
			(org_id,kind,effective_at,plan_from,plan_to,term_start,term_end,breakdown,created_at)
			VALUES($1,'redeem',$2,$3,$4,$2,$5,jsonb_build_object('redeem_code_id',$6::bigint),$7)`,
			orgID, start, sub.PlanKey, plan, end, codeID, now)
	}
	if err == nil {
		_, err = ProjectSubscription(ctx, tx, orgID, now)
	}
	if err != nil {
		return RedeemResult{}, redeemErr(500, "INTERNAL", "兑换失败")
	}
	return RedeemResult{PlanKey: plan, PlanStores: stores, PlanMonths: months, StartsAt: &start, EndsAt: &end}, nil
}
