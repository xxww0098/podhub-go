package billingrepo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	billingcontract "github.com/xxww0098/podhub-go/internal/admin/billing/contract"
	"github.com/xxww0098/podhub-go/internal/admin/billing/domain"
	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

const redeemSelect = `
	SELECT r.id, r.code, r.wallet_cents::bigint, r.plan_key, r.plan_stores, r.plan_months,
	       r.batch_id::text, r.note,
	       to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
	       creator.email,
	       CASE WHEN r.expires_at IS NULL THEN NULL ELSE
	           to_char(r.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
	       CASE WHEN r.used_at_ms > 0 THEN
	           to_char(to_timestamp(r.used_at_ms / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
	       used_by.email, used_org.name,
	       CASE WHEN r.revoked_at IS NULL THEN NULL ELSE
	           to_char(r.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
	       revoked_by.email, r.used, r.revoked_at, r.expires_at
	  FROM redeem_codes r
	  LEFT JOIN account_users creator ON creator.id = r.created_by_user_id
	  LEFT JOIN account_users used_by ON used_by.id = r.used_by_user_id
	  LEFT JOIN organizations used_org ON used_org.id = r.used_by_org_id
	  LEFT JOIN account_users revoked_by ON revoked_by.id = r.revoked_by_user_id`

type redeemRow struct {
	ID           int64
	Code         string
	WalletCents  int64
	PlanKey      *string
	PlanStores   *int32
	PlanMonths   *int32
	BatchID      string
	Note         *string
	CreatedAt    string
	CreatedEmail *string
	ExpiresAt    *string
	UsedAt       *string
	UsedEmail    *string
	UsedOrg      *string
	RevokedAt    *string
	RevokedEmail *string
	Used         bool
	Revoked      *time.Time
	Expires      *time.Time
}

func scanRedeem(row pgx.Row) (redeemRow, error) {
	var item redeemRow
	err := row.Scan(&item.ID, &item.Code, &item.WalletCents, &item.PlanKey, &item.PlanStores, &item.PlanMonths, &item.BatchID, &item.Note, &item.CreatedAt,
		&item.CreatedEmail, &item.ExpiresAt, &item.UsedAt, &item.UsedEmail, &item.UsedOrg, &item.RevokedAt,
		&item.RevokedEmail, &item.Used, &item.Revoked, &item.Expires)
	return item, err
}

type redeemView struct {
	ID              int64   `json:"id"`
	CodePreview     string  `json:"code_preview"`
	WalletCents     int64   `json:"wallet_cents"`
	PlanKey         *string `json:"plan_key"`
	PlanStores      *int32  `json:"plan_stores"`
	PlanMonths      *int32  `json:"plan_months"`
	Status          string  `json:"status"`
	BatchID         string  `json:"batch_id"`
	Note            *string `json:"note"`
	CreatedAt       string  `json:"created_at"`
	CreatedByEmail  *string `json:"created_by_email"`
	ExpiresAt       *string `json:"expires_at"`
	UsedAt          *string `json:"used_at"`
	UsedByEmail     *string `json:"used_by_email"`
	UsedByWorkspace *string `json:"used_by_workspace"`
	RevokedAt       *string `json:"revoked_at"`
	RevokedByEmail  *string `json:"revoked_by_email"`
}

func (item redeemRow) view(now time.Time) redeemView {
	return redeemView{
		ID: item.ID, CodePreview: domain.CodePreview(item.Code), WalletCents: item.WalletCents,
		PlanKey: item.PlanKey, PlanStores: item.PlanStores, PlanMonths: item.PlanMonths,
		Status:  domain.RedeemStatus(item.Revoked != nil, item.Used, item.Expires, now),
		BatchID: item.BatchID, Note: item.Note, CreatedAt: item.CreatedAt, CreatedByEmail: item.CreatedEmail,
		ExpiresAt: item.ExpiresAt, UsedAt: item.UsedAt, UsedByEmail: item.UsedEmail, UsedByWorkspace: item.UsedOrg,
		RevokedAt: item.RevokedAt, RevokedByEmail: item.RevokedEmail,
	}
}

func (r *Entitlement) ListRedeem(ctx context.Context, actor corecontract.Actor) ([]byte, error) {
	tx, err := r.beginTx(ctx)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer tx.Rollback(ctx)
	if err := tenantx.EnterObserver(ctx, tx, actor.UserID); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer corerepo.EndLease(tx)
	rows, err := tx.Query(ctx, redeemSelect+` ORDER BY r.created_at DESC, r.id DESC`)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer rows.Close()
	now := r.now()
	codes := []redeemView{}
	var unused, redeemed, expired, revoked int64
	for rows.Next() {
		item, err := scanRedeem(rows)
		if err != nil {
			return nil, corerepo.MapBill(err, "INTERNAL", true)
		}
		view := item.view(now)
		switch view.Status {
		case "unused":
			unused++
		case "redeemed":
			redeemed++
		case "expired":
			expired++
		case "revoked":
			revoked++
		}
		codes = append(codes, view)
	}
	if err := rows.Err(); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	message, _ := json.Marshal(struct {
		Summary string `json:"summary"`
		Count   int    `json:"count"`
	}{fmt.Sprintf("列出兑换码 %d 条", len(codes)), len(codes)})
	if err := corerepo.AuditBill(ctx, tx, corerepo.OrgAtLeast0(actor.OrgID), actor.UserID, "admin", "redeem_code", "*", "GET",
		"/api/admin/redeem-codes", "redeem_codes_listed", string(message), corerepo.Lease{}); err != nil {
		return nil, corecontract.Internal("INTERNAL", err.Error())
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, corecontract.Internal("INTERNAL", err.Error())
	}
	return corerepo.Data(struct {
		Codes    []redeemView `json:"codes"`
		Total    int64        `json:"total"`
		Unused   int64        `json:"unused"`
		Redeemed int64        `json:"redeemed"`
		Expired  int64        `json:"expired"`
		Revoked  int64        `json:"revoked"`
	}{codes, int64(len(codes)), unused, redeemed, expired, revoked})
}

func (r *Entitlement) CreateRedeem(ctx context.Context, actor corecontract.Actor, spec billingcontract.RedeemSpec) ([]byte, error) {
	tx, err := r.beginTx(ctx)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer tx.Rollback(ctx)
	if err := tenantx.EnterObserver(ctx, tx, actor.UserID); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer corerepo.EndLease(tx)
	held, err := corerepo.Admit(ctx, tx, "admin", r.now().UnixMilli(), corecontract.WritesDisabled("WRITES_DISABLED", "管理域写入未启用"))
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	prefix := "POD-WALLET-"
	var planKey *string
	var planStores, planMonths *int32
	var planPrice *int64
	if spec.PlanKey != "" {
		prefix = "POD-PLAN-"
		planKey, planStores, planMonths = &spec.PlanKey, &spec.PlanStores, &spec.PlanMonths
		var price int64
		if err := tx.QueryRow(ctx, `SELECT store_monthly_cents FROM plans WHERE key=$1 AND active`, spec.PlanKey).Scan(&price); errors.Is(err, pgx.ErrNoRows) {
			return nil, corecontract.Validation("VALIDATION", "套餐不可用")
		} else if err != nil {
			return nil, corerepo.MapBill(err, "INTERNAL", true)
		}
		planPrice = &price
	}
	batch := uuid.NewString()
	created := r.now().UnixMilli()
	type createdCode struct {
		ID          int64   `json:"id"`
		Code        string  `json:"code"`
		WalletCents int64   `json:"wallet_cents"`
		PlanKey     *string `json:"plan_key"`
		PlanStores  *int32  `json:"plan_stores"`
		PlanMonths  *int32  `json:"plan_months"`
		BatchID     string  `json:"batch_id"`
		ExpiresAt   string  `json:"expires_at"`
	}
	out := make([]createdCode, 0, spec.Quantity)
	for i := int32(0); i < spec.Quantity; i++ {
		code := prefix + strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", ""))
		var id int64
		err := tx.QueryRow(ctx, `
			INSERT INTO redeem_codes
			       (code, wallet_cents, used, created_at_ms, created_at, updated_at,
			        batch_id, note, expires_at, created_by_user_id, plan_key, plan_stores, plan_months, plan_store_monthly_cents)
			VALUES ($1, $2, false, $3, clock_timestamp(), clock_timestamp(),
			        $4::uuid, $5, $6::timestamptz, $7, $8, $9, $10, $11)
			RETURNING id`,
			code, spec.WalletCents, created, batch, spec.Note, spec.ExpiresAt, actor.UserID, planKey, planStores, planMonths, planPrice).Scan(&id)
		if err != nil {
			return nil, corerepo.MapBill(err, "INTERNAL", true)
		}
		out = append(out, createdCode{
			ID: id, Code: code, WalletCents: spec.WalletCents, PlanKey: planKey, PlanStores: planStores, PlanMonths: planMonths, BatchID: batch, ExpiresAt: rfc3339Offset(spec.ExpiresAt),
		})
	}
	message, _ := json.Marshal(struct {
		Summary     string `json:"summary"`
		BatchID     string `json:"batch_id"`
		WalletCents int64  `json:"wallet_cents"`
		PlanKey     string `json:"plan_key,omitempty"`
		PlanStores  int32  `json:"plan_stores,omitempty"`
		PlanMonths  int32  `json:"plan_months,omitempty"`
		Quantity    int32  `json:"quantity"`
	}{fmt.Sprintf("创建兑换码 %d 个", spec.Quantity), batch, spec.WalletCents, spec.PlanKey, spec.PlanStores, spec.PlanMonths, spec.Quantity})
	if err := corerepo.AuditBill(ctx, tx, corerepo.OrgAtLeast0(actor.OrgID), actor.UserID, "admin", "redeem_code_batch", batch, "POST",
		"/api/admin/redeem-codes", "redeem_codes_created", string(message), held); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	body, err := corerepo.Data(struct {
		Codes []createdCode `json:"codes"`
	}{out})
	return body, err
}

func rfc3339Offset(t time.Time) string {
	text := t.UTC().Format(time.RFC3339Nano)
	if strings.HasSuffix(text, "Z") {
		return strings.TrimSuffix(text, "Z") + "+00:00"
	}
	return text
}

func (r *Entitlement) GetRedeem(ctx context.Context, actor corecontract.Actor, id int64) ([]byte, error) {
	tx, err := r.beginTx(ctx)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer tx.Rollback(ctx)
	if err := tenantx.EnterObserver(ctx, tx, actor.UserID); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	item, err := scanRedeem(tx.QueryRow(ctx, redeemSelect+` WHERE r.id = $1 LIMIT 1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, corecontract.NotFound("NOT_FOUND", "兑换码不存在")
	}
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	return corerepo.Data(item.view(r.now()))
}

func (r *Entitlement) DeleteRedeem(ctx context.Context, actor corecontract.Actor, id int64) ([]byte, error) {
	tx, err := r.beginTx(ctx)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer tx.Rollback(ctx)
	if err := tenantx.EnterObserver(ctx, tx, actor.UserID); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer corerepo.EndLease(tx)
	held, err := corerepo.Admit(ctx, tx, "admin", r.now().UnixMilli(), corecontract.WritesDisabled("WRITES_DISABLED", "管理域写入未启用"))
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	item, err := scanRedeem(tx.QueryRow(ctx, redeemSelect+` WHERE r.id = $1 LIMIT 1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, corecontract.NotFound("NOT_FOUND", "兑换码不存在")
	}
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if item.Used {
		return nil, corecontract.Conflict("CONFLICT", "已兑换的兑换码不能删除")
	}
	tag, err := tx.Exec(ctx, `DELETE FROM redeem_codes WHERE id = $1 AND used = false`, id)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if tag.RowsAffected() == 0 {
		return nil, corecontract.Conflict("CONFLICT", "兑换码不存在或已被兑换")
	}
	message, _ := json.Marshal(struct {
		Summary     string `json:"summary"`
		CodePreview string `json:"code_preview"`
	}{"删除兑换码", domain.CodeTail(item.Code)})
	if err := corerepo.AuditBill(ctx, tx, corerepo.OrgAtLeast0(actor.OrgID), actor.UserID, "admin", "redeem_code", fmt.Sprint(id), "DELETE",
		"/api/admin/redeem-codes/:id", "redeem_code_deleted", string(message), held); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	return corerepo.Data(struct {
		OK bool `json:"ok"`
	}{true})
}

func (r *Entitlement) RevokeRedeem(ctx context.Context, actor corecontract.Actor, id int64) ([]byte, error) {
	tx, err := r.beginTx(ctx)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer tx.Rollback(ctx)
	if err := tenantx.EnterObserver(ctx, tx, actor.UserID); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer corerepo.EndLease(tx)
	held, err := corerepo.Admit(ctx, tx, "admin", r.now().UnixMilli(), corecontract.WritesDisabled("WRITES_DISABLED", "管理域写入未启用"))
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	tag, err := tx.Exec(ctx, `
		UPDATE redeem_codes
		   SET revoked_at = clock_timestamp(), revoked_by_user_id = $1, updated_at = clock_timestamp()
		 WHERE id = $2 AND used = false AND revoked_at IS NULL`, actor.UserID, id)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if tag.RowsAffected() == 0 {
		return nil, corecontract.Conflict("CONFLICT", "兑换码不存在、已兑换或已作废")
	}
	message, _ := json.Marshal(struct {
		Summary string `json:"summary"`
	}{"作废兑换码"})
	if err := corerepo.AuditBill(ctx, tx, corerepo.OrgAtLeast0(actor.OrgID), actor.UserID, "admin", "redeem_code", fmt.Sprint(id), "POST",
		"/api/admin/redeem-codes/:id/revoke", "redeem_code_revoked", string(message), held); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	return corerepo.Data(struct {
		OK bool `json:"ok"`
	}{true})
}
