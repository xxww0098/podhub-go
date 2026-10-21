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
	var plan string
	err = tx.QueryRow(ctx, `
		SELECT uuid, dissolved_at, plan FROM organizations WHERE id = $1 FOR UPDATE`, orgID).Scan(&orgUUID, &dissolved, &plan)
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
		ID           int64
		Product      string
		MemberSeats  int64
		Tier         string
		OcrCredits   int64
		WalletCents  int64
		DurationDays int32
		Used         bool
		ExpiresAt    *time.Time
		RevokedAt    *time.Time
	}
	err = tx.QueryRow(ctx, `
		SELECT id, product, member_seats, tier, ocr_credits, wallet_cents,
		       duration_days, used, expires_at, revoked_at
		  FROM public.billing_lock_redeem_code($1)`, code).Scan(&row.ID, &row.Product, &row.MemberSeats, &row.Tier, &row.OcrCredits, &row.WalletCents, &row.DurationDays, &row.Used, &row.ExpiresAt, &row.RevokedAt)
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
	if row.DurationDays < 1 || row.DurationDays > 3650 {
		return RedeemResult{}, redeemErr(400, "VALIDATION", "兑换码有效期无效")
	}
	if row.ExpiresAt != nil && !row.ExpiresAt.After(time.Now()) {
		return RedeemResult{}, redeemErr(400, "VALIDATION", "兑换码已过期")
	}
	var result RedeemResult
	switch row.Product {
	case "ocr_credits":
		return RedeemResult{}, redeemErr(400, "VALIDATION", "识别额度兑换码已停用")
	case "member_seats":
		return RedeemResult{}, redeemErr(400, "VALIDATION", "成员席位批次兑换码已停用，不会消耗该兑换码，请联系运营")
	case "wallet_credits":
		if row.WalletCents < 100 || row.WalletCents > 1_000_000 || row.MemberSeats != 0 || row.OcrCredits != 0 {
			return RedeemResult{}, redeemErr(400, "VALIDATION", "兑换码钱包额度无效")
		}
		if _, err = AdjustTx(ctx, tx, orgID, fmt.Sprintf("redeem:%d", row.ID), row.WalletCents*1_000_000, "兑换码充值"); err != nil {
			return RedeemResult{}, redeemErr(500, "INTERNAL", "兑换失败")
		}
		result = RedeemResult{PlanKey: plan, WalletCents: row.WalletCents}
	default:
		return RedeemResult{}, redeemErr(400, "VALIDATION", "兑换码产品类型无效")
	}
	if err != nil {
		return RedeemResult{}, redeemErr(500, "INTERNAL", "兑换失败")
	}
	var consumed int
	err = tx.QueryRow(ctx, `SELECT public.billing_consume_redeem_code($1, $2, $3, $4)`, row.ID, userID, orgID, time.Now().UnixMilli()).Scan(&consumed)
	if err != nil {
		return RedeemResult{}, redeemErr(500, "INTERNAL", "兑换失败")
	}
	if consumed != 1 {
		return RedeemResult{}, redeemErr(400, "VALIDATION", "兑换码已被使用")
	}
	name, err := planName(ctx, tx, result.PlanKey)
	if err != nil {
		return RedeemResult{}, redeemErr(400, "VALIDATION", fmt.Sprintf("兑换码权益无效（%s），请联系客服", result.PlanKey))
	}
	result.PlanName = name
	return result, nil
}

func planName(ctx context.Context, tx pgx.Tx, key string) (string, error) {
	var name string
	err := tx.QueryRow(ctx, `SELECT name FROM plans WHERE key = $1`, key).Scan(&name)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(name) == "" {
		return key, nil
	}
	return name, nil
}
