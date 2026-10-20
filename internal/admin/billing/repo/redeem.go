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
)

const redeemSelect = `
	SELECT r.id, r.code, r.plan, COALESCE(p.name, r.plan) AS plan_name,
	       COALESCE(r.product, 'member_seats') AS product,
	       r.member_seats::bigint, COALESCE(r.tier, '') AS tier,
	       r.ocr_credits::bigint, r.wallet_cents::bigint, r.duration_days,
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
	  LEFT JOIN plans p ON p.key = r.plan
	  LEFT JOIN account_users creator ON creator.id = r.created_by_user_id
	  LEFT JOIN account_users used_by ON used_by.id = r.used_by_user_id
	  LEFT JOIN organizations used_org ON used_org.id = r.used_by_org_id
	  LEFT JOIN account_users revoked_by ON revoked_by.id = r.revoked_by_user_id`

type redeemRow struct {
	ID           int64
	Code         string
	Plan         string
	PlanName     string
	Product      string
	MemberSeats  int64
	Tier         string
	OcrCredits   int64
	WalletCents  int64
	DurationDays int32
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
	err := row.Scan(&item.ID, &item.Code, &item.Plan, &item.PlanName, &item.Product, &item.MemberSeats, &item.Tier,
		&item.OcrCredits, &item.WalletCents, &item.DurationDays, &item.BatchID, &item.Note, &item.CreatedAt,
		&item.CreatedEmail, &item.ExpiresAt, &item.UsedAt, &item.UsedEmail, &item.UsedOrg, &item.RevokedAt,
		&item.RevokedEmail, &item.Used, &item.Revoked, &item.Expires)
	return item, err
}

type redeemView struct {
	ID              int64   `json:"id"`
	CodePreview     string  `json:"code_preview"`
	Plan            string  `json:"plan"`
	PlanName        string  `json:"plan_name"`
	Product         string  `json:"product"`
	MemberSeats     int64   `json:"member_seats"`
	Tier            string  `json:"tier"`
	OcrCredits      int64   `json:"ocr_credits"`
	WalletCents     int64   `json:"wallet_cents"`
	DurationDays    int32   `json:"duration_days"`
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
		ID: item.ID, CodePreview: domain.CodePreview(item.Code), Plan: item.Plan, PlanName: item.PlanName,
		Product: item.Product, MemberSeats: item.MemberSeats, Tier: item.Tier, OcrCredits: item.OcrCredits,
		WalletCents: item.WalletCents, DurationDays: item.DurationDays,
		Status:  domain.RedeemStatus(item.Revoked != nil, item.Used, item.Expires, now),
		BatchID: item.BatchID, Note: item.Note, CreatedAt: item.CreatedAt, CreatedByEmail: item.CreatedEmail,
		ExpiresAt: item.ExpiresAt, UsedAt: item.UsedAt, UsedByEmail: item.UsedEmail, UsedByWorkspace: item.UsedOrg,
		RevokedAt: item.RevokedAt, RevokedByEmail: item.RevokedEmail,
	}
}

func (r *Entitlement) ListRedeem(ctx context.Context, actor corecontract.Actor) ([]byte, error) {
	rows, err := r.Pool.Query(ctx, redeemSelect+` ORDER BY r.created_at DESC, r.id DESC`)
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
	tx, err := r.beginTx(ctx)
	if err != nil {
		return nil, corecontract.Internal("INTERNAL", err.Error())
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
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
	if spec.NeedsPlan {
		var name string
		err := r.Pool.QueryRow(ctx, `SELECT name FROM plans WHERE key = $1 LIMIT 1`, spec.PlanKey).Scan(&name)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, corecontract.Validation("VALIDATION", "档位目录缺失")
		}
		if err != nil {
			return nil, corecontract.Internal("INTERNAL", err.Error())
		}
		spec.PlanName = name
	}
	tx, err := r.beginTx(ctx)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	held, err := corerepo.Admit(ctx, tx, "admin", r.now().UnixMilli(), corecontract.WritesDisabled("WRITES_DISABLED", "管理域写入未启用"))
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	prefix := "POD-PLAN-"
	if spec.Product == "wallet_credits" {
		prefix = "POD-WALLET-"
	}
	batch := uuid.NewString()
	created := r.now().UnixMilli()
	type createdCode struct {
		ID           int64  `json:"id"`
		Code         string `json:"code"`
		Plan         string `json:"plan"`
		PlanName     string `json:"plan_name"`
		Product      string `json:"product"`
		MemberSeats  int64  `json:"member_seats"`
		Tier         string `json:"tier"`
		OcrCredits   int64  `json:"ocr_credits"`
		WalletCents  int64  `json:"wallet_cents"`
		DurationDays int32  `json:"duration_days"`
		BatchID      string `json:"batch_id"`
		ExpiresAt    string `json:"expires_at"`
	}
	out := make([]createdCode, 0, spec.Quantity)
	tier := spec.Tier
	for i := int32(0); i < spec.Quantity; i++ {
		code := prefix + strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", ""))
		var id int64
		err := tx.QueryRow(ctx, `
			INSERT INTO redeem_codes
			       (code, plan, product, member_seats, tier, ocr_credits, wallet_cents, duration_days, used,
			        created_at_ms, created_at, updated_at, batch_id, note, expires_at, created_by_user_id)
			VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8, false, $9, clock_timestamp(), clock_timestamp(),
			        $10::uuid, $11, $12::timestamptz, $13)
			RETURNING id`,
			code, spec.PlanKey, spec.Product, spec.MemberSeats, tier, spec.OcrCredits, spec.WalletCents,
			spec.DurationDays, created, batch, spec.Note, spec.ExpiresAt, actor.UserID).Scan(&id)
		if err != nil {
			return nil, corerepo.MapBill(err, "INTERNAL", true)
		}
		out = append(out, createdCode{
			ID: id, Code: code, Plan: spec.PlanKey, PlanName: spec.PlanName, Product: spec.Product,
			MemberSeats: spec.MemberSeats, Tier: spec.Tier, OcrCredits: spec.OcrCredits, WalletCents: spec.WalletCents,
			DurationDays: spec.DurationDays, BatchID: batch, ExpiresAt: rfc3339Offset(spec.ExpiresAt),
		})
	}
	tierOut := spec.Tier
	message, _ := json.Marshal(struct {
		Summary     string `json:"summary"`
		BatchID     string `json:"batch_id"`
		Plan        string `json:"plan"`
		Product     string `json:"product"`
		MemberSeats int64  `json:"member_seats"`
		Tier        string `json:"tier"`
		OcrCredits  int64  `json:"ocr_credits"`
		WalletCents int64  `json:"wallet_cents"`
		Quantity    int32  `json:"quantity"`
	}{fmt.Sprintf("创建兑换码 %d 个", spec.Quantity), batch, spec.PlanKey, spec.Product, spec.MemberSeats, tierOut, spec.OcrCredits, spec.WalletCents, spec.Quantity})
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
	_ = actor
	item, err := scanRedeem(r.Pool.QueryRow(ctx, redeemSelect+` WHERE r.id = $1 LIMIT 1`, id))
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
