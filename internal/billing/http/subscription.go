package billinghttp

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	"github.com/xxww0098/podhub-go/internal/billing/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

const agreementVersion = "subscription-2026-10-31"
const agreementContent = "套餐从购买日起按月计算，到期日与购买日同日，按店铺数量和套餐单价统一续费；每个工作区最多购买 100 家店铺，成员不收费。购买或续费 12 个月享年付 8 折，优惠码在年付折扣后叠加；两项优惠均不适用于本期扩容补差。优惠码按成功创建订单计次，取消订单不返还次数；下单前会再次校验有效期和剩余次数，已创建订单的价格冻结。到期前系统按月生成续费订单，需您选择支付方式并付款后才生效，不会自动扣款。减少续费名额只改变尚未购买的期间，已付权益继续用满，本次调整不自动退款。服务到期未续费后，该工作区所有店铺冻结，不能发布、同步或发放密钥，店铺配置和历史数据保留，续费后恢复。提高已付期间容量按剩余服务时间补差。"

// errBillingNotWired means the billing repo functions were not assembled.
var errBillingNotWired = errors.New("billing repo is not wired")

func (h handler) registerSubscription(r chi.Router) {
	r.Get("/api/billing/subscription", h.subscription)
	r.Post("/api/billing/quotes", h.subscriptionQuote)
	r.Post("/api/billing/keep", h.subscriptionKeep)
	r.Post("/api/billing/orders", h.subscriptionOrder)
	r.Get("/api/billing/orders/{public_id}", h.subscriptionOrderView)
	r.Post("/api/billing/orders/{public_id}/pay", h.subscriptionPayAuto)
	r.Put("/api/billing/auto-renew", h.subscriptionAutoRenew)
}

// checkProvider resolves the payment channel a buyer picked. An empty value is
// the manual channel; anything else must be configured and enabled.
func (h handler) checkProvider(w http.ResponseWriter, r *http.Request, provider string) (string, bool) {
	if provider == "" {
		provider = "manual"
	}
	if provider == contract.ProviderUnselected {
		writeAPI(w, 400, "支付方式无效", "VALIDATION")
		return "", false
	}
	if provider != "manual" {
		if h.deps.Runtime == nil {
			h.checkoutError(w, service.ErrPaymentClosed)
			return "", false
		}
		if _, err := h.deps.Runtime.Configuration(r.Context(), provider); err != nil {
			h.checkoutError(w, err)
			return "", false
		}
	}
	return provider, true
}

func agreementJSON(now time.Time, userID int64) []byte {
	b, _ := json.Marshal(map[string]string{"version": agreementVersion, "title": "订阅购买确认", "content": agreementContent, "effective_at": "2026-10-31", "accepted_at": now.Format("2006-01-02T15:04:05Z07:00"), "accepted_by": strconv.FormatInt(userID, 10)})
	return b
}

func (h handler) subscriptionActor(w http.ResponseWriter, r *http.Request, write bool) *access.Principal {
	p, refusal, err := resolve(h.deps.Access, r)
	if err != nil {
		writeAPI(w, 500, "服务暂不可用", "INTERNAL")
		return nil
	}
	if refusal != nil {
		code := "FORBIDDEN"
		if refusal.Status == 401 {
			code = "AUTH_REQUIRED"
		}
		writeAPI(w, refusal.Status, refusal.Message, code)
		return nil
	}
	if p == nil {
		writeAPI(w, 401, access.MsgUnauthenticated, "AUTH_REQUIRED")
		return nil
	}
	if p.OrgID <= 0 {
		writeAPI(w, 403, access.MsgNoWorkspace, "FORBIDDEN")
		return nil
	}
	if write && !access.CanManage(p.WorkspaceRole) {
		writeAPI(w, 403, "只有工作区所有者或管理员可以管理订阅", "FORBIDDEN")
		return nil
	}
	if h.deps.Pool == nil {
		writeAPI(w, 503, "服务暂不可用", "INTERNAL")
		return nil
	}
	return p
}
func decodeSubscription(w http.ResponseWriter, r *http.Request, out any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		writeAPI(w, 400, "请求格式无效", "VALIDATION")
		return false
	}
	if err := dec.Decode(new(any)); !errors.Is(err, io.EOF) {
		writeAPI(w, 400, "请求只能包含一个对象", "VALIDATION")
		return false
	}
	return true
}
func (h handler) subscriptionError(w http.ResponseWriter, err error) {
	var q *domain.QuoteError
	if errors.As(err, &q) {
		writeAPI(w, q.Status, q.Message, q.Code)
		return
	}
	if h.deps.Billing.ErrNoSubscription != nil && errors.Is(err, h.deps.Billing.ErrNoSubscription) {
		writeAPI(w, 409, "工作区缺少订阅记录", "SUBSCRIPTION_MISSING")
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		writeAPI(w, 404, "记录不存在", "NOT_FOUND")
		return
	}
	writeAPI(w, 500, "订阅操作失败，请刷新后重试", "INTERNAL")
}
func (h handler) subscription(w http.ResponseWriter, r *http.Request) {
	p := h.subscriptionActor(w, r, false)
	if p == nil {
		return
	}
	if h.deps.Billing.SubscriptionView == nil {
		h.subscriptionError(w, errBillingNotWired)
		return
	}
	out, err := h.deps.Billing.SubscriptionView(r.Context(), h.deps.Pool, p.OrgID, h.now())
	if err != nil {
		h.subscriptionError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	jsonwire.Write(w, 200, struct {
		contract.View
		Agreement map[string]string `json:"purchase_agreement"`
	}{out, map[string]string{"version": agreementVersion, "title": "订阅购买确认", "content": agreementContent, "effective_at": "2026-10-31"}})
}
func (h handler) subscriptionQuote(w http.ResponseWriter, r *http.Request) {
	p := h.subscriptionActor(w, r, true)
	if p == nil {
		return
	}
	var req contract.QuoteRequest
	if !decodeSubscription(w, r, &req) {
		return
	}
	if _, err := uuid.Parse(req.ExpectedWorkspace); err != nil {
		writeAPI(w, 400, "请指定当前工作区编号", "VALIDATION")
		return
	}

	if h.deps.Billing.Quote == nil {
		h.subscriptionError(w, errBillingNotWired)
		return
	}
	out, err := h.deps.Billing.Quote(r.Context(), h.deps.Pool, p.OrgID, req, h.now())
	if err != nil {
		h.subscriptionError(w, err)
		return
	}
	jsonwire.Write(w, 200, out)
}
func (h handler) subscriptionKeep(w http.ResponseWriter, r *http.Request) {
	p := h.subscriptionActor(w, r, true)
	if p == nil {
		return
	}
	var req struct {
		QuoteID       string `json:"quote_id"`
		CancelPending bool   `json:"cancel_pending"`
	}
	if !decodeSubscription(w, r, &req) {
		return
	}
	if _, err := uuid.Parse(req.QuoteID); err != nil {
		writeAPI(w, 400, "报价编号无效", "VALIDATION")
		return
	}
	if h.deps.Billing.ConfirmKeep == nil {
		h.subscriptionError(w, errBillingNotWired)
		return
	}
	if err := h.deps.Billing.ConfirmKeep(r.Context(), h.deps.Pool, p.OrgID, req.QuoteID, req.CancelPending, h.now()); err != nil {
		h.subscriptionError(w, err)
		return
	}
	h.subscription(w, r)
}
func (h handler) subscriptionOrder(w http.ResponseWriter, r *http.Request) {
	p := h.subscriptionActor(w, r, true)
	if p == nil {
		return
	}
	var req struct {
		QuoteID         string `json:"quote_id"`
		AcceptedVersion string `json:"accepted_version"`
		Provider        string `json:"provider"`
	}
	if !decodeSubscription(w, r, &req) {
		return
	}
	if req.AcceptedVersion != agreementVersion {
		writeAPI(w, 400, "请阅读并同意当前购买确认", "VALIDATION")
		return
	}
	if _, err := uuid.Parse(req.QuoteID); err != nil {
		writeAPI(w, 400, "报价编号无效", "VALIDATION")
		return
	}
	provider, ok := h.checkProvider(w, r, req.Provider)
	if !ok {
		return
	}
	req.Provider = provider
	now := h.now()
	agreement := agreementJSON(now, p.UserID)
	if h.deps.Billing.CreateSubscriptionOrder == nil {
		h.subscriptionError(w, errBillingNotWired)
		return
	}
	out, err := h.deps.Billing.CreateSubscriptionOrder(r.Context(), h.deps.Pool, p.OrgID, p.UserID, "po_"+uuid.NewString(), req.Provider, "CNY", req.QuoteID, agreement, now)
	if err != nil {
		h.subscriptionError(w, err)
		return
	}
	if h.deps.Runtime != nil {
		order, err := h.deps.Runtime.Launch(r.Context(), p.OrgID, out.PublicID)
		if err != nil && (order.ID == 0 || order.EntryState() != "entry_confirming") {
			h.checkoutError(w, err)
			return
		}
		out.Provider = order.Provider
		out.EntryState = order.EntryState()
		out.QRCode = order.QRCode
		out.PayURL = order.PayURL
	}
	jsonwire.Write(w, 201, out)
}

// subscriptionPayAuto confirms an auto-issued renewal order: the buyer accepts
// the agreement and picks a channel, then the usual entry launch runs.
func (h handler) subscriptionPayAuto(w http.ResponseWriter, r *http.Request) {
	p := h.subscriptionActor(w, r, true)
	if p == nil {
		return
	}
	var req struct {
		AcceptedVersion string `json:"accepted_version"`
		Provider        string `json:"provider"`
	}
	if !decodeSubscription(w, r, &req) {
		return
	}
	if req.AcceptedVersion != agreementVersion {
		writeAPI(w, 400, "请阅读并同意当前购买确认", "VALIDATION")
		return
	}
	provider, ok := h.checkProvider(w, r, req.Provider)
	if !ok {
		return
	}
	if h.deps.Billing.PayAutoOrder == nil {
		h.subscriptionError(w, errBillingNotWired)
		return
	}
	now := h.now()
	out, err := h.deps.Billing.PayAutoOrder(r.Context(), h.deps.Pool, p.OrgID, p.UserID, chi.URLParam(r, "public_id"), provider, agreementJSON(now, p.UserID), now)
	if err != nil {
		h.subscriptionError(w, err)
		return
	}
	if h.deps.Runtime != nil {
		order, err := h.deps.Runtime.Launch(r.Context(), p.OrgID, out.PublicID)
		if err != nil && (order.ID == 0 || order.EntryState() != "entry_confirming") {
			h.checkoutError(w, err)
			return
		}
		out.Provider = order.Provider
		out.EntryState = order.EntryState()
		out.QRCode = order.QRCode
		out.PayURL = order.PayURL
	}
	jsonwire.Write(w, 200, out)
}

func (h handler) subscriptionAutoRenew(w http.ResponseWriter, r *http.Request) {
	p := h.subscriptionActor(w, r, true)
	if p == nil {
		return
	}
	var req struct {
		Enabled *bool `json:"enabled"`
	}
	if !decodeSubscription(w, r, &req) {
		return
	}
	if req.Enabled == nil {
		writeAPI(w, 400, "请指定是否开启自动续费订单", "VALIDATION")
		return
	}
	if h.deps.Billing.SetAutoRenew == nil {
		h.subscriptionError(w, errBillingNotWired)
		return
	}
	if err := h.deps.Billing.SetAutoRenew(r.Context(), h.deps.Pool, p.OrgID, *req.Enabled, h.now()); err != nil {
		h.subscriptionError(w, err)
		return
	}
	h.subscription(w, r)
}
func (h handler) subscriptionOrderView(w http.ResponseWriter, r *http.Request) {
	p := h.subscriptionActor(w, r, true)
	if p == nil {
		return
	}
	var out struct {
		PublicID   string          `json:"public_id"`
		Status     string          `json:"status"`
		Amount     int64           `json:"amount_cents"`
		Reason     *string         `json:"reconciliation_reason"`
		Agreement  json.RawMessage `json:"purchase_agreement"`
		Provider   string          `json:"provider,omitempty"`
		EntryState string          `json:"entry_state,omitempty"`
		QRCode     *string         `json:"qr_code,omitempty"`
		PayURL     *string         `json:"pay_url,omitempty"`
	}
	err := db.InTx(r.Context(), h.deps.Pool, db.App(p.OrgID), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `SELECT public_id,status,amount_cents,reconciliation_reason,purchase_agreement FROM payment_orders WHERE org_id=$1 AND public_id=$2 AND product='subscription'`, p.OrgID, chi.URLParam(r, "public_id")).Scan(&out.PublicID, &out.Status, &out.Amount, &out.Reason, &out.Agreement)
	})
	if err != nil {
		h.subscriptionError(w, err)
		return
	}
	if h.deps.Runtime != nil {
		order, err := h.deps.Runtime.Store.Get(r.Context(), p.OrgID, out.PublicID)
		if err != nil {
			h.checkoutError(w, err)
			return
		}
		out.Provider = order.Provider
		out.EntryState = order.EntryState()
		out.QRCode = order.QRCode
		out.PayURL = order.PayURL
	}
	w.Header().Set("Cache-Control", "no-store")
	jsonwire.Write(w, 200, out)
}
