package billinghttp

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	"github.com/xxww0098/podhub-go/internal/billing/service"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

func (h handler) registerCheckout(r chi.Router) {
	r.Get("/api/payment-methods", h.paymentMethods)
	r.Post("/api/ai/recharge/orders", h.rechargeCreate)
	r.Post("/api/ai/recharge/orders/{public_id}/recover", h.rechargeRecover)
	r.Get("/api/orders", h.ownOrders)
	r.Get("/api/orders/{public_id}", h.ownOrder)
	r.Post("/api/orders/{public_id}/recover", h.ownRecover)
	r.Post("/api/orders/{public_id}/cancel", h.ownCancel)
}

func paymentsFromConfiguration(c contract.PaymentConfiguration) (Payments, error) {
	p := Payments{}
	v := c.Values
	switch c.Provider {
	case "alipay":
		pub, err := domain.ParsePublicPEM(v["alipayPublicKey"])
		if err != nil {
			return p, err
		}
		p.Alipay = &AlipayKey{AppID: v["appId"], Public: pub}
	case "wechat":
		pub, err := domain.ParsePublicPEM(v["publicKey"])
		if err != nil {
			return p, err
		}
		p.Wechat = &WechatKey{MchID: v["mchId"], AppID: v["appId"], PublicKeyID: v["publicKeyId"], Public: pub, APIv3Key: []byte(v["apiV3Key"])}
	case "stripe":
		p.Stripe = &StripeKey{Secret: v["webhookSecret"]}
	case "easypay":
		p.EasyPayPID = v["pid"]
		p.EasyPayKey = v["pkey"]
	case "airwallex":
		p.Airwallex = &AirwallexKey{Secret: v["webhookSecret"], AccountID: v["accountId"]}
	default:
		return p, service.ErrPaymentClosed
	}
	return p, nil
}

func VerifyAirwallex(key AirwallexKey, timestamp, signature string, body []byte, now time.Time) (Notice, error) {
	return domain.VerifyAirwallex(key, timestamp, signature, body, now)
}

func (h handler) checkoutError(w http.ResponseWriter, err error) {
	if errors.Is(err, service.ErrPaymentClosed) {
		writeAPI(w, 503, "支付渠道未开放或配置不完整", "PAYMENT_NOT_AVAILABLE")
		return
	}
	h.subscriptionError(w, err)
}

func (h handler) paymentMethods(w http.ResponseWriter, r *http.Request) {
	p, refusal, err := resolve(h.deps.Access, r)
	if err != nil {
		writeAPI(w, 500, "支付配置暂不可用", "INTERNAL")
		return
	}
	if p == nil || refusal != nil {
		writeAPI(w, 401, "请先登录", "AUTH_INVALID")
		return
	}
	providers := []string{}
	if h.deps.Runtime != nil {
		providers, err = h.deps.Runtime.Methods(r.Context())
		if err != nil {
			writeAPI(w, 500, "支付配置暂不可用", "INTERNAL")
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	jsonwire.Write(w, 200, map[string]any{"providers": providers, "manual": true})
}

type rechargeView struct {
	PublicID      string  `json:"public_id"`
	OperationID   string  `json:"operation_id"`
	AmountCents   int64   `json:"amount_cents"`
	TopupMicrofen int64   `json:"topup_microfen"`
	Currency      string  `json:"currency"`
	Provider      string  `json:"provider"`
	Status        string  `json:"status"`
	EntryState    string  `json:"entry_state"`
	CreatedAt     string  `json:"created_at"`
	PaidAt        *string `json:"paid_at,omitempty"`
	CanceledAt    *string `json:"canceled_at,omitempty"`
	QRCode        *string `json:"qr_code,omitempty"`
	PayURL        *string `json:"pay_url,omitempty"`
}

func rechargePublic(o contract.CheckoutOrder) rechargeView {
	v := rechargeView{PublicID: o.PublicID, OperationID: o.OperationID, AmountCents: o.AmountCents, TopupMicrofen: o.TopupMicrofen, Currency: o.Currency, Provider: o.Provider, Status: o.Status, EntryState: o.EntryState(), CreatedAt: contract.RFC3339Millis(o.CreatedAt), QRCode: o.QRCode, PayURL: o.PayURL}
	if o.PaidAt != nil {
		s := contract.RFC3339Millis(*o.PaidAt)
		v.PaidAt = &s
	}
	if o.CanceledAt != nil {
		s := contract.RFC3339Millis(*o.CanceledAt)
		v.CanceledAt = &s
	}
	return v
}

func orderPublic(o contract.CheckoutOrder) map[string]any {
	v := map[string]any{"public_id": o.PublicID, "plan": o.Plan, "months": o.Months, "amount_cents": o.AmountCents, "currency": o.Currency, "provider": o.Provider, "status": o.Status, "entry_state": o.EntryState(), "created_at": contract.RFC3339Millis(o.CreatedAt)}
	if o.QRCode != nil {
		v["qr_code"] = *o.QRCode
	}
	if o.PayURL != nil {
		v["pay_url"] = *o.PayURL
	}
	if o.PaidAt != nil {
		v["paid_at"] = contract.RFC3339Millis(*o.PaidAt)
	}
	if o.CanceledAt != nil {
		v["canceled_at"] = contract.RFC3339Millis(*o.CanceledAt)
	}
	if len(o.Agreement) > 0 {
		v["purchase_agreement"] = o.Agreement
	}
	return v
}

func (h handler) rechargeCreate(w http.ResponseWriter, r *http.Request) {
	p := h.subscriptionActor(w, r, true)
	if p == nil {
		return
	}
	var req struct {
		OperationID string `json:"operation_id"`
		Amount      int64  `json:"amount_cents"`
		Provider    string `json:"provider"`
		Workspace   string `json:"expected_workspace_uuid"`
	}
	if !decodeSubscription(w, r, &req) {
		return
	}
	req.OperationID = strings.TrimSpace(req.OperationID)
	if len(req.OperationID) == 0 || len(req.OperationID) > 64 {
		writeAPI(w, 400, "operation_id 长度无效", "VALIDATION")
		return
	}
	if _, err := uuid.Parse(req.Workspace); err != nil {
		writeAPI(w, 400, "请指定当前工作区编号", "VALIDATION")
		return
	}
	if h.deps.Runtime == nil {
		h.checkoutError(w, service.ErrPaymentClosed)
		return
	}
	if req.Provider != "manual" {
		if _, err := h.deps.Runtime.Configuration(r.Context(), req.Provider); err != nil {
			h.checkoutError(w, err)
			return
		}
	}
	o, err := h.deps.Runtime.Store.CreateTopup(r.Context(), p.OrgID, p.UserID, req.Workspace, req.OperationID, "po_"+uuid.NewString(), req.Provider, req.Amount, h.now())
	if err == nil {
		o, err = h.deps.Runtime.Launch(r.Context(), p.OrgID, o.PublicID)
		if err != nil && o.ID > 0 && o.EntryState() == "entry_confirming" {
			err = nil
		}
	}
	if err != nil {
		h.checkoutError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	jsonwire.Write(w, 200, map[string]any{"order": rechargePublic(o)})
}

func (h handler) checkoutOrder(w http.ResponseWriter, r *http.Request, recharge, recover, cancel bool) {
	p := h.subscriptionActor(w, r, true)
	if p == nil {
		return
	}
	if h.deps.Runtime == nil {
		h.checkoutError(w, service.ErrPaymentClosed)
		return
	}
	id := chi.URLParam(r, "public_id")
	o, err := h.deps.Runtime.Store.Get(r.Context(), p.OrgID, id)
	if err != nil {
		h.checkoutError(w, err)
		return
	}
	if recharge && o.Product != "wallet_topup" {
		writeAPI(w, 404, "订单不存在", "NOT_FOUND")
		return
	}
	if (recover || cancel) && o.Status == "pending" && !contract.NoChannel(o.Provider) {
		var notice *domain.Notice
		o, notice, err = h.deps.Runtime.Recover(r.Context(), p.OrgID, id)
		if err == nil && notice != nil && (notice.Paid || notice.Canceled) {
			err = h.apply(r.Context(), *notice)
			if err == nil {
				o, err = h.deps.Runtime.Store.Get(r.Context(), p.OrgID, id)
			}
		}
	}
	if cancel && err == nil {
		if o.Status != "pending" {
			writeAPI(w, 409, "订单已结算", "CONFLICT")
			return
		}
		if !contract.NoChannel(o.Provider) {
			err = h.deps.Runtime.Close(r.Context(), o)
		}
		if err == nil {
			err = h.deps.Runtime.Store.Cancel(r.Context(), p.OrgID, id)
		}
		if err == nil {
			o, err = h.deps.Runtime.Store.Get(r.Context(), p.OrgID, id)
		}
	}
	if err != nil {
		h.checkoutError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if recharge {
		jsonwire.Write(w, 200, map[string]any{"order": rechargePublic(o)})
	} else {
		jsonwire.Write(w, 200, map[string]any{"order": orderPublic(o)})
	}
}

func (h handler) rechargeRecover(w http.ResponseWriter, r *http.Request) {
	h.checkoutOrder(w, r, true, true, false)
}
func (h handler) ownOrder(w http.ResponseWriter, r *http.Request) {
	h.checkoutOrder(w, r, false, false, false)
}
func (h handler) ownRecover(w http.ResponseWriter, r *http.Request) {
	h.checkoutOrder(w, r, false, true, false)
}
func (h handler) ownCancel(w http.ResponseWriter, r *http.Request) {
	h.checkoutOrder(w, r, false, false, true)
}
func (h handler) ownOrders(w http.ResponseWriter, r *http.Request) {
	p := h.subscriptionActor(w, r, true)
	if p == nil {
		return
	}
	if h.deps.Runtime == nil {
		h.checkoutError(w, service.ErrPaymentClosed)
		return
	}
	limit := 50
	var err error
	if text := r.URL.Query().Get("limit"); text != "" {
		limit, err = strconv.Atoi(text)
	}
	if err != nil || limit < 1 || limit > 200 {
		writeAPI(w, 400, "分页数量无效", "VALIDATION")
		return
	}
	var before int64
	if text := r.URL.Query().Get("cursor"); text != "" {
		raw, e := base64.RawURLEncoding.DecodeString(text)
		if e == nil {
			before, e = strconv.ParseInt(string(raw), 10, 64)
		}
		if e != nil || before <= 0 {
			writeAPI(w, 400, "分页游标无效", "VALIDATION")
			return
		}
	}
	status := r.URL.Query().Get("status")
	if status != "" && status != "pending" && status != "paid" && status != "canceled" {
		writeAPI(w, 400, "订单状态无效", "VALIDATION")
		return
	}
	rows, err := h.deps.Runtime.Store.List(r.Context(), p.OrgID, status, before, limit+1)
	if err != nil {
		h.checkoutError(w, err)
		return
	}
	result := map[string]any{}
	if len(rows) > limit {
		result["next_cursor"] = base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(rows[limit-1].ID, 10)))
		rows = rows[:limit]
	}
	list := []map[string]any{}
	for _, o := range rows {
		list = append(list, orderPublic(o))
	}
	result["orders"] = list
	w.Header().Set("Cache-Control", "no-store")
	jsonwire.Write(w, 200, result)
}
