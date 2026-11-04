package billingrepo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	billingcontract "github.com/xxww0098/podhub-go/internal/billing/contract"

	"github.com/xxww0098/podhub-go/internal/admin/billing/domain"
	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

const confirmAPIPath = "/api/admin/orders/{public_id}/confirm"

type planView struct {
	Key           string   `json:"key"`
	Name          string   `json:"name"`
	Tagline       string   `json:"tagline"`
	StoreMonthly  int64    `json:"store_monthly_cents"`
	S3UploadBytes int64    `json:"s3_upload_bytes_monthly"`
	AITokens      int64    `json:"ai_tokens_monthly"`
	Highlights    []string `json:"highlights"`
	AdminOnly     bool     `json:"admin_only"`
}

func (r *Entitlement) ListPlans(ctx context.Context, actor corecontract.Actor) ([]byte, error) {
	tx, err := r.beginTx(ctx)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	rows, err := tx.Query(ctx, `
		SELECT key, name, tagline, store_monthly_cents,
		       s3_upload_bytes_monthly, ai_tokens_monthly, highlights, admin_only
		  FROM plans
		 WHERE active = true
		 ORDER BY sort_order ASC, key ASC`)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer rows.Close()
	plans := []planView{}
	for rows.Next() {
		var view planView
		var highlights string
		if err := rows.Scan(&view.Key, &view.Name, &view.Tagline, &view.StoreMonthly,
			&view.S3UploadBytes, &view.AITokens, &highlights, &view.AdminOnly); err != nil {
			return nil, corerepo.MapBill(err, "INTERNAL", true)
		}
		view.Highlights = highlightStrings(highlights)
		plans = append(plans, view)
	}
	if err := rows.Err(); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	message, _ := json.Marshal(struct {
		Summary string `json:"summary"`
		Count   int    `json:"count"`
	}{Summary: fmt.Sprintf("列出权益目录 %d 条", len(plans)), Count: len(plans)})
	if err := corerepo.AuditBill(ctx, tx, corerepo.OrgAtLeast0(actor.OrgID), actor.UserID, "admin", "plan", "*", "GET", "/api/admin/plans", "plans_listed", string(message), corerepo.Lease{}); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	return corerepo.Data(struct {
		Plans []planView `json:"plans"`
	}{Plans: plans})
}

func highlightStrings(raw string) []string {
	var values []any
	if json.Unmarshal([]byte(raw), &values) != nil {
		return []string{}
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if text, ok := value.(string); ok {
			out = append(out, text)
			continue
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			continue
		}
		out = append(out, string(encoded))
	}
	return out
}

type orderView struct {
	PublicID       string  `json:"public_id"`
	OrgID          int64   `json:"org_id"`
	WorkspaceName  string  `json:"workspace_name"`
	CreatedByEmail string  `json:"created_by_email"`
	Plan           string  `json:"plan"`
	Months         int32   `json:"months"`
	AmountCents    int64   `json:"amount_cents"`
	Currency       string  `json:"currency"`
	Provider       string  `json:"provider"`
	Status         string  `json:"status"`
	CreatedAt      string  `json:"created_at"`
	PaidAt         *string `json:"paid_at"`
	CanceledAt     *string `json:"canceled_at"`
}

const orderSelect = `
	SELECT o.public_id, o.org_id, COALESCE(org.name, '') AS workspace_name,
	       COALESCE(u.email, '') AS created_by_email,
	       COALESCE(o.plan, o.product) AS plan,
	       o.months, o.amount_cents, o.currency, o.provider, o.status,
	       o.created_at, o.paid_at, o.canceled_at
	  FROM payment_orders o
	  LEFT JOIN organizations org ON org.id = o.org_id
	  LEFT JOIN account_users u ON u.id = o.created_by_user_id`

func scanOrder(row pgx.Row) (orderView, error) {
	var view orderView
	var created time.Time
	var paid, canceled *time.Time
	err := row.Scan(&view.PublicID, &view.OrgID, &view.WorkspaceName, &view.CreatedByEmail, &view.Plan,
		&view.Months, &view.AmountCents, &view.Currency, &view.Provider,
		&view.Status, &created, &paid, &canceled)
	if err != nil {
		return orderView{}, err
	}
	view.CreatedAt = billingcontract.RFC3339Millis(created)
	if paid != nil {
		text := billingcontract.RFC3339Millis(*paid)
		view.PaidAt = &text
	}
	if canceled != nil {
		text := billingcontract.RFC3339Millis(*canceled)
		view.CanceledAt = &text
	}
	return view, nil
}

func (r *Entitlement) ListOrders(ctx context.Context, actor corecontract.Actor) ([]byte, error) {
	tx, err := r.beginTx(ctx)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer tx.Rollback(ctx)
	if err := tenantx.EnterObserver(ctx, tx, actor.UserID); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	rows, err := tx.Query(ctx, orderSelect+` ORDER BY o.created_at DESC LIMIT 200`)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer rows.Close()
	orders := []orderView{}
	for rows.Next() {
		view, err := scanOrder(rows)
		if err != nil {
			return nil, corerepo.MapBill(err, "INTERNAL", true)
		}
		orders = append(orders, view)
	}
	if err := rows.Err(); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	return corerepo.Data(struct {
		Orders []orderView `json:"orders"`
	}{Orders: orders})
}

func (r *Entitlement) GetOrder(ctx context.Context, actor corecontract.Actor, publicID string) ([]byte, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer tx.Rollback(ctx)
	orgID, err := paymentOrg(ctx, tx, publicID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, corecontract.NotFound("NOT_FOUND", "订单不存在")
	}
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if err := tenantx.EnterApp(ctx, tx, orgID); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	view, err := scanOrder(tx.QueryRow(ctx, orderSelect+` WHERE o.public_id = $1 LIMIT 1`, publicID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, corecontract.NotFound("NOT_FOUND", "订单不存在")
	}
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	_ = actor
	return corerepo.Data(view)
}

func paymentOrg(ctx context.Context, tx pgx.Tx, publicID string) (int64, error) {
	return scanBillingOrg(tx.QueryRow(ctx, `SELECT public.billing_payment_order_org($1)`, publicID))
}

func lockPaymentOrg(ctx context.Context, tx pgx.Tx, publicID string) (int64, error) {
	return paymentOrg(ctx, tx, publicID)
}

// A scalar SQL function returns NULL when the order is missing. That is not a row.
func scanBillingOrg(row pgx.Row) (int64, error) {
	var orgID *int64
	if err := row.Scan(&orgID); err != nil {
		return 0, err
	}
	if orgID == nil {
		return 0, pgx.ErrNoRows
	}
	return *orgID, nil
}

var entitlementOff = corecontract.WritesDisabled("WRITES_DISABLED", "权益域写入未启用")

type loadedOrder struct {
	id        int64
	publicID  string
	orgID     int64
	product   string
	plan      string
	months    int32
	amount    int64
	topup     *int64
	currency  string
	provider  string
	status    string
	createdBy int64
}

func (r *Entitlement) loadOrder(ctx context.Context, tx pgx.Tx, publicID string) (loadedOrder, error) {
	var order loadedOrder
	err := tx.QueryRow(ctx, `
		SELECT id, public_id, org_id, product, COALESCE(plan, '') AS plan, months,
		       amount_cents, topup_microfen, currency, provider, status, created_by_user_id
		  FROM payment_orders
		 WHERE public_id = $1
		 LIMIT 1`, publicID).Scan(&order.id, &order.publicID, &order.orgID, &order.product, &order.plan,
		&order.months, &order.amount, &order.topup, &order.currency, &order.provider, &order.status, &order.createdBy)
	return order, err
}

func lockLiveOrg(ctx context.Context, tx pgx.Tx, orgID int64) error {
	var dissolved bool
	err := tx.QueryRow(ctx, `
		SELECT dissolved_at IS NOT NULL AS dissolved
		  FROM organizations
		 WHERE id = $1
		 FOR NO KEY UPDATE`, orgID).Scan(&dissolved)
	if errors.Is(err, pgx.ErrNoRows) || dissolved {
		return corecontract.Validation("VALIDATION", "工作空间已解散")
	}
	return err
}

func (r *Entitlement) ConfirmOrder(ctx context.Context, actor corecontract.Actor, publicID string) ([]byte, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	orgID, err := lockPaymentOrg(ctx, tx, publicID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, corecontract.NotFound("NOT_FOUND", "订单不存在")
	}
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if err := tenantx.EnterApp(ctx, tx, orgID); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	held, err := corerepo.Admit(ctx, tx, "entitlement", r.now().UnixMilli(), entitlementOff)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if err := lockLiveOrg(ctx, tx, orgID); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	order, err := r.loadOrder(ctx, tx, publicID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, corecontract.NotFound("NOT_FOUND", "订单不存在")
	}
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	// An auto-renewal proposal has no payment channel and no purchase agreement
	// until the buyer picks one. Confirming it as received would grant paid
	// entitlement without a payment or an acceptance.
	if order.provider == "unselected" {
		return nil, corecontract.Conflict("CONFLICT", "未选择支付渠道的自动续费订单不能直接确认收款")
	}
	if err := lockLiveOrg(ctx, tx, order.orgID); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	tag, err := tx.Exec(ctx, `
		UPDATE payment_orders
		   SET status = 'paid',
		       paid_at = clock_timestamp(),
		       provider_ref = COALESCE(NULL, provider_ref),
		       qr_code = NULL,
		       pay_url = NULL,
		       launch_state = NULL,
		       updated_at = clock_timestamp()
		 WHERE public_id = $1 AND status = 'pending'`, publicID)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if tag.RowsAffected() == 0 {
		return nil, corecontract.Conflict("CONFLICT", "订单已处理")
	}
	if r.SettleFirstOrderCommission == nil {
		return nil, corerepo.MapBill(errBillingNotWired, "INTERNAL", true)
	}
	if err := r.SettleFirstOrderCommission(ctx, tx, order.id, actor.UserID, "PUT", confirmAPIPath); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	switch domain.ConfirmProduct(order.product) {
	case domain.EdgeSubscription:
		if r.FulfillSubscriptionOrder == nil {
			return nil, corerepo.MapBill(errBillingNotWired, "INTERNAL", true)
		}
		if err := r.FulfillSubscriptionOrder(ctx, tx, publicID, r.now()); err != nil {
			return nil, corerepo.MapBill(err, "INTERNAL", true)
		}
		if err := corerepo.AuditBill(ctx, tx, order.orgID, actor.UserID, "entitlement", "payment_order", publicID, "PUT", "/api/admin/orders/"+publicID+"/confirm", "subscription_payment_settled", fmt.Sprintf(`{"amount_cents":%d}`, order.amount), held); err != nil {
			return nil, err
		}
	case domain.EdgeWalletTopup:
		if err := r.settleWallet(ctx, tx, actor, held, order); err != nil {
			return nil, corerepo.MapBill(err, "INTERNAL", true)
		}
	case domain.EdgePlatformGoods:
		if err := r.settlePlatform(ctx, tx, actor, held, order); err != nil {
			return nil, corerepo.MapBill(err, "INTERNAL", true)
		}
	default:
		return nil, corecontract.Validation("VALIDATION", "订单商品无效")
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	return r.GetOrder(ctx, actor, publicID)
}

func (r *Entitlement) settleWallet(ctx context.Context, tx pgx.Tx, actor corecontract.Actor, held corerepo.Lease, order loadedOrder) error {
	if order.topup == nil || *order.topup <= 0 {
		return corecontract.Internal("INTERNAL", corerepo.MsgUnavailable)
	}
	amount := *order.topup
	if err := creditWallet(ctx, tx, order.orgID, order.publicID, order.id, amount, "topup", ""); err != nil {
		return err
	}
	message, _ := json.Marshal(struct {
		AmountCents   int64 `json:"amount_cents"`
		TopupMicrofen int64 `json:"topup_microfen"`
	}{AmountCents: order.amount, TopupMicrofen: amount})
	return corerepo.AuditBill(ctx, tx, order.orgID, actor.UserID, "entitlement", "payment_order", order.publicID, "PUT",
		"/api/admin/orders/"+order.publicID+"/confirm", "wallet_topup_settled", string(message), held)
}

func (r *Entitlement) settlePlatform(ctx context.Context, tx pgx.Tx, actor corecontract.Actor, held corerepo.Lease, order loadedOrder) error {
	tag, err := tx.Exec(ctx, `
		UPDATE public.sc_orders
		   SET status = 'awaiting_procurement', updated_at_ms = $2
		 WHERE payment_order_public_id = $1 AND status = 'awaiting_payment'`, order.publicID, r.now().UnixMilli())
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return corecontract.NotFound("NOT_FOUND", "平台订单不存在")
	}
	message, _ := json.Marshal(struct {
		AmountCents int64 `json:"amount_cents"`
	}{AmountCents: order.amount})
	return corerepo.AuditBill(ctx, tx, order.orgID, actor.UserID, "entitlement", "payment_order", order.publicID, "PUT",
		"/api/admin/orders/"+order.publicID+"/confirm", "platform_goods_payment_settled", string(message), held)
}

func (r *Entitlement) CancelOrder(ctx context.Context, actor corecontract.Actor, publicID string) ([]byte, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	orgID, err := lockPaymentOrg(ctx, tx, publicID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, corecontract.NotFound("NOT_FOUND", "订单不存在")
	}
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if err := tenantx.EnterApp(ctx, tx, orgID); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	held, err := corerepo.Admit(ctx, tx, "entitlement", r.now().UnixMilli(), entitlementOff)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	order, err := r.loadOrder(ctx, tx, publicID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, corecontract.NotFound("NOT_FOUND", "订单不存在")
	}
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	switch domain.CancelPending(true, order.status, order.provider) {
	case domain.CancelHandled:
		return nil, corecontract.Conflict("CONFLICT", "订单已处理")
	case domain.CancelUpstream:
		return nil, corecontract.Conflict("CONFLICT", "线上订单须由支付渠道确认关闭后取消，请稍后刷新订单")
	}
	tag, err := tx.Exec(ctx, `
		UPDATE payment_orders
		   SET status = 'canceled',
		       canceled_at = clock_timestamp(),
		       qr_code = NULL,
		       pay_url = NULL,
		       launch_state = NULL,
		       updated_at = clock_timestamp()
		 WHERE public_id = $1 AND status = 'pending'`, publicID)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if tag.RowsAffected() == 0 {
		return nil, corecontract.Conflict("CONFLICT", "订单已处理")
	}
	message, _ := json.Marshal(struct {
		Plan string `json:"plan"`
	}{Plan: order.plan})
	if err := corerepo.AuditBill(ctx, tx, order.orgID, actor.UserID, "entitlement", "payment_order", order.publicID, "POST",
		"/api/orders/"+order.publicID+"/cancel", "payment_order_canceled", string(message), held); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if _, err := r.loadOrder(ctx, tx, publicID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, corecontract.NotFound("NOT_FOUND", "订单不存在")
		}
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	return r.GetOrder(ctx, actor, publicID)
}
