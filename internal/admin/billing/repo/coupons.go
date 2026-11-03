package billingrepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

const couponColumns = `code,discount_percent,starts_at,expires_at,max_uses,used_count,enabled,created_at`

func scanCoupon(row pgx.Row) (billing.Coupon, error) {
	var out billing.Coupon
	err := row.Scan(&out.Code, &out.DiscountPercent, &out.StartsAt, &out.ExpiresAt, &out.MaxUses, &out.UsedCount, &out.Enabled, &out.CreatedAt)
	return out, err
}

func (r *Entitlement) ListCoupons(ctx context.Context, actor corecontract.Actor) ([]byte, error) {
	out := []billing.Coupon{}
	err := db.InTx(ctx, r.Pool, db.Observer(actor.UserID), func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+couponColumns+` FROM subscription_coupons ORDER BY created_at DESC,code`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			item, err := scanCoupon(rows)
			if err != nil {
				return err
			}
			out = append(out, item)
		}
		if err = rows.Err(); err != nil {
			return err
		}
		return corerepo.AuditBill(ctx, tx, corerepo.OrgAtLeast0(actor.OrgID), actor.UserID, "admin", "subscription_coupon", "*", "GET", "/api/admin/subscription-coupons", "subscription_coupons_listed", "列出订阅优惠码", corerepo.Lease{})
	})
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	return corerepo.Data(struct {
		Coupons []billing.Coupon `json:"coupons"`
	}{out})
}

func (r *Entitlement) CreateCoupon(ctx context.Context, actor corecontract.Actor, spec billing.CouponSpec) ([]byte, error) {
	spec, err := billing.ValidateCouponSpec(spec, r.now())
	if err != nil {
		return nil, corecontract.Validation("VALIDATION", err.Error())
	}
	var out billing.Coupon
	err = db.InTx(ctx, r.Pool, db.Observer(actor.UserID), func(tx pgx.Tx) error {
		defer corerepo.EndLease(tx)
		held, err := corerepo.Admit(ctx, tx, "admin", r.now().UnixMilli(), corecontract.WritesDisabled("WRITES_DISABLED", "管理域写入未启用"))
		if err != nil {
			return err
		}
		out, err = scanCoupon(tx.QueryRow(ctx, `INSERT INTO subscription_coupons(code,discount_percent,starts_at,expires_at,max_uses) VALUES($1,$2,$3,$4,$5) ON CONFLICT(code) DO NOTHING RETURNING `+couponColumns, spec.Code, spec.DiscountPercent, spec.StartsAt, spec.ExpiresAt, spec.MaxUses))
		if errors.Is(err, pgx.ErrNoRows) {
			return corecontract.Conflict("COUPON_EXISTS", "优惠码已存在")
		}
		if err != nil {
			return err
		}
		return corerepo.AuditBill(ctx, tx, corerepo.OrgAtLeast0(actor.OrgID), actor.UserID, "admin", "subscription_coupon", spec.Code, "POST", "/api/admin/subscription-coupons", "subscription_coupon_created", "创建订阅优惠码", held)
	})
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	return corerepo.Data(out)
}

func (r *Entitlement) SetCouponEnabled(ctx context.Context, actor corecontract.Actor, code string, enabled bool) ([]byte, error) {
	canonical, ok := billing.CanonicalCouponCode(code)
	if !ok {
		return nil, corecontract.Validation("VALIDATION", "优惠码格式无效")
	}
	var out billing.Coupon
	err := db.InTx(ctx, r.Pool, db.Observer(actor.UserID), func(tx pgx.Tx) error {
		defer corerepo.EndLease(tx)
		held, err := corerepo.Admit(ctx, tx, "admin", r.now().UnixMilli(), corecontract.WritesDisabled("WRITES_DISABLED", "管理域写入未启用"))
		if err != nil {
			return err
		}
		out, err = scanCoupon(tx.QueryRow(ctx, `UPDATE subscription_coupons SET enabled=$2 WHERE code=$1 RETURNING `+couponColumns, canonical, enabled))
		if errors.Is(err, pgx.ErrNoRows) {
			return corecontract.NotFound("NOT_FOUND", "优惠码不存在")
		}
		if err != nil {
			return err
		}
		return corerepo.AuditBill(ctx, tx, corerepo.OrgAtLeast0(actor.OrgID), actor.UserID, "admin", "subscription_coupon", canonical, "PUT", "/api/admin/subscription-coupons/"+canonical, "subscription_coupon_updated", "更新优惠码启用状态", held)
	})
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	return corerepo.Data(out)
}
