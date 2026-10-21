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

type planView struct {
	Key            string   `json:"key"`
	Name           string   `json:"name"`
	Tagline        string   `json:"tagline"`
	PriceMonthly   int64    `json:"price_monthly"`
	PriceYearly    int64    `json:"price_yearly"`
	IncludedSeats  int64    `json:"included_seats"`
	MaxStores      int64    `json:"max_stores"`
	MemberSeats    int64    `json:"member_seats"`
	StoreLimit     int64    `json:"store_limit"`
	OcrMonthly     int64    `json:"ocr_monthly"`
	AssetMonthly   int64    `json:"asset_monthly"`
	ListingMonthly int64    `json:"listing_monthly"`
	S3UploadBytes  int64    `json:"s3_upload_bytes_monthly"`
	AITokens       int64    `json:"ai_tokens_monthly"`
	Highlights     []string `json:"highlights"`
	AdminOnly      bool     `json:"admin_only"`
}

func (r *Entitlement) ListPlans(ctx context.Context, actor corecontract.Actor) ([]byte, error) {
	rows, err := r.Pool.Query(ctx, `
		SELECT key, name, tagline, price_monthly_cents, price_yearly_cents,
		       seat_limit, max_stores, ocr_monthly, asset_monthly, listing_monthly,
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
		if err := rows.Scan(&view.Key, &view.Name, &view.Tagline, &view.PriceMonthly, &view.PriceYearly,
			&view.IncludedSeats, &view.MaxStores, &view.OcrMonthly, &view.AssetMonthly, &view.ListingMonthly,
			&view.S3UploadBytes, &view.AITokens, &highlights, &view.AdminOnly); err != nil {
			return nil, corerepo.MapBill(err, "INTERNAL", true)
		}
		view.MemberSeats = view.IncludedSeats
		view.StoreLimit = view.MaxStores
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
	tx, err := r.beginTx(ctx)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", true)
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
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
	MemberSeats    int64   `json:"member_seats"`
	Months         int32   `json:"months"`
	AmountCents    int64   `json:"amount_cents"`
	CreditCents    int64   `json:"credit_cents"`
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
	       COALESCE(o.member_seats, 0)::bigint AS member_seats,
	       o.months, o.amount_cents, o.credit_cents, o.currency, o.provider, o.status,
	       o.created_at, o.paid_at, o.canceled_at
	  FROM payment_orders o
	  LEFT JOIN organizations org ON org.id = o.org_id
	  LEFT JOIN account_users u ON u.id = o.created_by_user_id`

func scanOrder(row pgx.Row) (orderView, error) {
	var view orderView
	var created time.Time
	var paid, canceled *time.Time
	err := row.Scan(&view.PublicID, &view.OrgID, &view.WorkspaceName, &view.CreatedByEmail, &view.Plan,
		&view.MemberSeats, &view.Months, &view.AmountCents, &view.CreditCents, &view.Currency, &view.Provider,
		&view.Status, &created, &paid, &canceled)
	if err != nil {
		return orderView{}, err
	}
	view.CreatedAt = corerepo.RFC3339Millis(created)
	if paid != nil {
		text := corerepo.RFC3339Millis(*paid)
		view.PaidAt = &text
	}
	if canceled != nil {
		text := corerepo.RFC3339Millis(*canceled)
		view.CanceledAt = &text
	}
	return view, nil
}

func (r *Entitlement) ListOrders(ctx context.Context, actor corecontract.Actor) ([]byte, error) {
	rows, err := r.Pool.Query(ctx, orderSelect+` ORDER BY o.created_at DESC LIMIT 200`)
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
	_ = actor
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
	id           int64
	publicID     string
	orgID        int64
	product      string
	plan         string
	seats        int64
	months       int32
	unitMonth    int64
	durationDays int32
	amount       int64
	credit       int64
	topup        *int64
	currency     string
	provider     string
	status       string
	renews       *int64
	createdBy    int64
}

func (r *Entitlement) loadOrder(ctx context.Context, tx pgx.Tx, publicID string) (loadedOrder, error) {
	var order loadedOrder
	err := tx.QueryRow(ctx, `
		SELECT id, public_id, org_id, product, COALESCE(plan, '') AS plan,
		       COALESCE(member_seats, 0)::bigint, months,
		       COALESCE(unit_month_cents, 0)::bigint,
		       COALESCE(duration_days, 0),
		       amount_cents, credit_cents, topup_microfen, currency, provider, status,
		       renews_lot_id, created_by_user_id
		  FROM payment_orders
		 WHERE public_id = $1
		 LIMIT 1`, publicID).Scan(&order.id, &order.publicID, &order.orgID, &order.product, &order.plan,
		&order.seats, &order.months, &order.unitMonth, &order.durationDays, &order.amount, &order.credit,
		&order.topup, &order.currency, &order.provider, &order.status, &order.renews, &order.createdBy)
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
	if order.product == "subscription" {
		if err := billingcontract.FulfillSubscriptionOrder(ctx, tx, publicID, r.now()); err != nil {
			return nil, corerepo.MapBill(err, "INTERNAL", true)
		}
		if err := corerepo.AuditBill(ctx, tx, order.orgID, actor.UserID, "entitlement", "payment_order", publicID, "PUT", "/api/admin/orders/"+publicID+"/confirm", "subscription_payment_settled", fmt.Sprintf(`{"amount_cents":%d}`, order.amount), held); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return r.GetOrder(ctx, actor, publicID)
	}
	switch domain.ConfirmProduct(order.product, order.seats, int64(order.durationDays)) {
	case domain.EdgeWalletTopup:
		if err := r.settleWallet(ctx, tx, actor, held, order); err != nil {
			return nil, corerepo.MapBill(err, "INTERNAL", true)
		}
	case domain.EdgePlatformGoods:
		if err := r.settlePlatform(ctx, tx, actor, held, order); err != nil {
			return nil, corerepo.MapBill(err, "INTERNAL", true)
		}
	case domain.EdgeMemberSeats:
		var settleErr error
		if order.credit > 0 {
			settleErr = r.settleCredit(ctx, tx, actor, held, order)
		} else {
			settleErr = r.settleSeats(ctx, tx, actor, held, order)
		}
		if settleErr != nil {
			var fault *corecontract.Fault
			if errors.As(settleErr, &fault) && fault.Kind == "fulfillment" {
				_ = tx.Rollback(ctx)
				auditFailed(ctx, r.Pool, order.publicID, fault.Message)
				return nil, corecontract.Unavailable("INTERNAL", "订单已收款但权益发放失败，订单保持待支付；请稍后重试")
			}
			return nil, corerepo.MapBill(settleErr, "INTERNAL", true)
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

func (r *Entitlement) settleSeats(ctx context.Context, tx pgx.Tx, actor corecontract.Actor, held corerepo.Lease, order loadedOrder) error {
	if !domain.SeatTier(order.plan) {
		return corecontract.Validation("VALIDATION", "成员名额档位无效")
	}
	var starts time.Time
	var renews any
	if order.renews != nil {
		err := tx.QueryRow(ctx, `
			SELECT expires_at FROM member_seat_lots WHERE id = $1 AND org_id = $2 LIMIT 1`, *order.renews, order.orgID).Scan(&starts)
		if errors.Is(err, pgx.ErrNoRows) {
			return corecontract.Validation("VALIDATION", "续费批次不存在")
		}
		if err != nil {
			return err
		}
		renews = *order.renews
	}
	var lotID int64
	var expires time.Time
	if order.renews != nil {
		err := tx.QueryRow(ctx, `
			INSERT INTO member_seat_lots
			       (org_id, tier, seats, starts_at, expires_at, payment_order_id, renews_lot_id, created_at)
			VALUES ($1, $2, $3, $4, $4 + make_interval(days => $5::int), $6, $7, $4)
			RETURNING id, expires_at`, order.orgID, order.plan, order.seats, starts, order.durationDays, order.id, renews).Scan(&lotID, &expires)
		if err != nil {
			return err
		}
	} else {
		err := tx.QueryRow(ctx, `
			INSERT INTO member_seat_lots
			       (org_id, tier, seats, starts_at, expires_at, payment_order_id, created_at)
			SELECT $1, $2, $3, clock.now, clock.now + make_interval(days => $4::int), $5, clock.now
			  FROM (SELECT clock_timestamp() AS now) clock
			RETURNING id, starts_at, expires_at`, order.orgID, order.plan, order.seats, order.durationDays, order.id).Scan(&lotID, &starts, &expires)
		if err != nil {
			return err
		}
	}
	if err := seatRoom(ctx, tx, order, starts, expires); err != nil {
		return err
	}
	var planExpires *time.Time
	if err := tx.QueryRow(ctx, `
		WITH clock AS (SELECT clock_timestamp() AS now)
		SELECT MAX(expires_at) FROM member_seat_lots, clock
		 WHERE org_id = $1 AND expires_at > clock.now`, order.orgID).Scan(&planExpires); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE organizations
		   SET plan = $1,
		       seat_limit = GREATEST($2, 1),
		       plan_expires_at = $3,
		       quota_revision = quota_revision + 1,
		       updated_at = clock_timestamp()
		 WHERE id = $4
		   AND (plan IS DISTINCT FROM $1
		        OR seat_limit IS DISTINCT FROM GREATEST($2, 1)
		        OR plan_expires_at IS DISTINCT FROM $3)`, order.plan, order.seats, planExpires, order.orgID); err != nil {
		return err
	}
	expiresText := ""
	if planExpires != nil {
		expiresText = corerepo.RFC3339Millis(*planExpires)
	}
	message, _ := json.Marshal(struct {
		Plan             string  `json:"plan"`
		MemberSeats      int64   `json:"member_seats"`
		DurationDays     int32   `json:"duration_days"`
		GrossAmountCents int64   `json:"gross_amount_cents"`
		CreditCents      int64   `json:"credit_cents"`
		CreditedLotIDs   []int64 `json:"credited_lot_ids"`
		AmountCents      int64   `json:"amount_cents"`
		PlanExpiresAt    string  `json:"plan_expires_at"`
	}{order.plan, order.seats, order.durationDays, order.amount + order.credit, order.credit, []int64{}, order.amount, expiresText})
	_ = lotID
	return corerepo.AuditBill(ctx, tx, order.orgID, actor.UserID, "entitlement", "payment_order", order.publicID, "PUT",
		"/api/admin/orders/"+order.publicID+"/confirm", "payment_order_settled", string(message), held)
}

func seatRoom(ctx context.Context, tx pgx.Tx, order loadedOrder, start, end time.Time) error {
	rows, err := tx.Query(ctx, `
		SELECT seats::bigint, starts_at, expires_at
		  FROM member_seat_lots
		 WHERE org_id = $1 AND starts_at < $3 AND expires_at > $2`, order.orgID, start, end)
	if err != nil {
		return err
	}
	defer rows.Close()
	var seats []int64
	var starts, ends []time.Time
	for rows.Next() {
		var n int64
		var a, b time.Time
		if err := rows.Scan(&n, &a, &b); err != nil {
			return err
		}
		seats = append(seats, n)
		starts = append(starts, a)
		ends = append(ends, b)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	seats = append(seats, order.seats)
	starts = append(starts, start)
	ends = append(ends, end)
	if domain.PeakSeats(starts, ends, seats) > 20 {
		return corecontract.Validation("VALIDATION", "一个工作空间最多 20 个成员名额")
	}
	return nil
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
