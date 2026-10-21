package billinghttp

import (
	"context"
	"encoding/json"
	"errors"
	"html"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/billing/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// Payments holds loopback verification keys. A nil provider answers 503 and never dials.
type Payments struct {
	Alipay     *AlipayKey
	Wechat     *WechatKey
	Stripe     *StripeKey
	EasyPayPID string
	EasyPayKey string
}

// Deps is the billing HTTP surface. An empty Payments value refuses callbacks.
type Deps struct {
	Pool     *pgxpool.Pool
	Access   access.Resolver
	Payments Payments
	Now      func() time.Time
}

// Register mounts payment callbacks and redeem. It does not add OpenAPI paths.
func Register(router chi.Router, deps Deps) {
	h := handler{deps: deps}
	router.Post("/api/billing/callback", h.callbackAlipay)
	router.Post("/api/billing/webhooks/{provider}", h.webhook)
	router.Get("/api/billing/webhooks/{provider}", h.webhookGet)
	router.Get("/api/billing/callback/complete", h.complete)
	router.Post("/api/redeem", h.redeem)
	h.registerSubscription(router)
}

type handler struct{ deps Deps }

func (h handler) now() time.Time {
	if h.deps.Now != nil {
		return h.deps.Now()
	}
	return time.Now()
}

func (h handler) callbackAlipay(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	h.dispatch(w, r, "alipay", body)
}

func (h handler) webhook(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	h.dispatch(w, r, chi.URLParam(r, "provider"), body)
}

func (h handler) webhookGet(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if provider != "easypay" {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	h.dispatch(w, r, provider, []byte(r.URL.RawQuery))
}

func (h handler) dispatch(w http.ResponseWriter, r *http.Request, provider string, body []byte) {
	switch provider {
	case "alipay", "wechat", "stripe", "easypay", "airwallex":
	default:
		http.Error(w, "unknown provider", http.StatusNotFound)
		return
	}
	notice, ok, err := h.verify(provider, r, body)
	if err != nil {
		if errors.Is(err, errProviderClosed) {
			writeAPI(w, http.StatusServiceUnavailable, "支付渠道未开放", "PAYMENT_NOT_AVAILABLE")
			return
		}
		http.Error(w, "invalid notification", http.StatusBadRequest)
		return
	}
	if ok {
		if err := h.apply(r.Context(), notice); err != nil {
			http.Error(w, "failed", http.StatusBadRequest)
			return
		}
	}
	if provider == "alipay" || provider == "easypay" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("success"))
		return
	}
	w.WriteHeader(http.StatusOK)
}

var errProviderClosed = errors.New("closed")

func (h handler) verify(provider string, r *http.Request, body []byte) (Notice, bool, error) {
	now := h.now()
	switch provider {
	case "alipay":
		if h.deps.Payments.Alipay == nil {
			return Notice{}, false, errProviderClosed
		}
		notice, err := VerifyAlipay(*h.deps.Payments.Alipay, FormValues(body), now)
		return notice, err == nil, err
	case "easypay":
		if h.deps.Payments.EasyPayKey == "" {
			return Notice{}, false, errProviderClosed
		}
		notice, err := VerifyEasyPay(h.deps.Payments.EasyPayPID, h.deps.Payments.EasyPayKey, FormValues(body), now)
		return notice, err == nil, err
	case "wechat":
		if h.deps.Payments.Wechat == nil {
			return Notice{}, false, errProviderClosed
		}
		header := map[string]string{}
		for key, values := range r.Header {
			if len(values) > 0 {
				header[key] = values[0]
			}
		}
		notice, err := VerifyWechat(*h.deps.Payments.Wechat, header, body, now)
		return notice, err == nil, err
	case "stripe":
		if h.deps.Payments.Stripe == nil {
			return Notice{}, false, errProviderClosed
		}
		notice, err := VerifyStripe(*h.deps.Payments.Stripe, r.Header.Get("Stripe-Signature"), body, now)
		if err != nil {
			return Notice{}, false, err
		}
		if notice.Ignored {
			return notice, false, nil
		}
		return notice, true, nil
	default:
		return Notice{}, false, errProviderClosed
	}
}

func (h handler) apply(ctx context.Context, notice Notice) error {
	if h.deps.Pool == nil {
		return errors.New("no database")
	}
	if !notice.Paid && !notice.Canceled {
		return nil
	}
	tx, err := h.deps.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var orgID *int64
	err = tx.QueryRow(ctx, `SELECT public.billing_payment_order_org($1)`, notice.PublicID).Scan(&orgID)
	if err != nil {
		return err
	}
	if orgID == nil {
		return pgx.ErrNoRows
	}
	if err := tenantx.EnterApp(ctx, tx, *orgID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT id FROM organizations WHERE id=$1 FOR UPDATE`, *orgID); err != nil {
		return err
	}
	var order struct {
		ID       int64
		OrgID    int64
		Amount   int64
		Currency string
		Provider string
		Status   string
		Product  string
		Topup    *int64
	}
	err = tx.QueryRow(ctx, `
		SELECT id, org_id, amount_cents, currency, provider, status, product, topup_microfen
		  FROM payment_orders WHERE public_id = $1 FOR UPDATE`, notice.PublicID).Scan(
		&order.ID, &order.OrgID, &order.Amount, &order.Currency, &order.Provider, &order.Status, &order.Product, &order.Topup)
	if err != nil {
		return err
	}
	now := h.now()
	if order.Status == "paid" {
		return tx.Commit(ctx)
	}
	if !providerMatches(notice.Provider, order.Provider) || order.Amount != notice.AmountCents || !strings.EqualFold(order.Currency, notice.Currency) {
		if notice.Paid && !notice.Canceled {
			if err := service.MarkOrderReconciled(ctx, tx, order.ID, "amount_mismatch"); err != nil {
				return err
			}
			return tx.Commit(ctx)
		}
		return errors.New("mismatch")
	}
	if notice.Canceled {
		if order.Status != "pending" {
			return tx.Commit(ctx)
		}
		tag, err := tx.Exec(ctx, `
			UPDATE payment_orders
			   SET status = 'canceled', canceled_at = clock_timestamp(), updated_at = clock_timestamp()
			 WHERE id = $1 AND status = 'pending'`, order.ID)
		if err != nil || tag.RowsAffected() != 1 {
			return errors.New("cancel")
		}
		return tx.Commit(ctx)
	}
	if order.Product != "wallet_topup" && order.Product != "subscription" {
		// Platform goods are fulfilled by their own domain after the callback.
		// Marking them paid here would double-book.
		return errors.New("unfulfilled")
	}
	paid, err := service.MarkOrderPaid(ctx, tx, order.ID, notice.ProviderRef, now)
	if err != nil {
		return err
	}
	if !paid {
		return tx.Commit(ctx)
	}
	switch order.Product {
	case "wallet_topup":
		if order.Topup == nil || *order.Topup <= 0 {
			return errors.New("topup amount missing")
		}
		if _, err := TopupTx(ctx, tx, order.OrgID, notice.PublicID, order.ID, *order.Topup); err != nil {
			return err
		}
	case "subscription":
		full, err := service.LoadOrder(ctx, tx, notice.PublicID)
		if err != nil {
			return err
		}
		if err := service.FulfillSubscription(ctx, tx, full, now); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func providerMatches(notice, order string) bool {
	if notice == order {
		return true
	}
	return notice == "easypay" && strings.HasPrefix(order, "easypay_")
}

var paymentIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

func (h handler) complete(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("payment_id")
	if !paymentIDPattern.MatchString(id) {
		id = "unknown"
	}
	status := r.URL.Query().Get("status")
	switch status {
	case "succeeded":
	case "failed", "canceled", "cancelled":
		status = "failed"
	default:
		status = "unknown"
	}
	title := "支付未完成"
	if status == "succeeded" {
		title = "支付完成"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte("<!doctype html><title>" + html.EscapeString(title) + "</title><p>" + html.EscapeString(status) + " " + html.EscapeString(id) + "</p>"))
}

func (h handler) redeem(w http.ResponseWriter, r *http.Request) {
	principal, refusal, err := resolve(h.deps.Access, r)
	if err != nil || h.deps.Pool == nil {
		writeAPI(w, http.StatusInternalServerError, "兑换失败", "INTERNAL")
		return
	}
	if refusal != nil {
		code := "FORBIDDEN"
		if refusal.Kind == access.RefusalUnauthenticated || refusal.Status == http.StatusUnauthorized {
			code = "AUTH_REQUIRED"
		}
		writeAPI(w, refusal.Status, refusal.Message, code)
		return
	}
	if principal == nil {
		writeAPI(w, http.StatusUnauthorized, access.MsgUnauthenticated, "AUTH_REQUIRED")
		return
	}
	if status, message, ok := access.OrgManager(*principal); !ok {
		writeAPI(w, status, message, "FORBIDDEN")
		return
	}
	if principal.WorkspaceRole != "owner" {
		writeAPI(w, http.StatusForbidden, "只有 Workspace 所有者可以加购成员名额", "NOT_WORKSPACE_OWNER")
		return
	}
	var body struct {
		Code     string `json:"code"`
		Expected string `json:"expected_workspace_uuid"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeAPI(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
		return
	}
	result, err := Redeem(r.Context(), h.deps.Pool, principal.OrgID, principal.UserID, body.Code, body.Expected)
	if err != nil {
		var refusal *RedeemError
		if errors.As(err, &refusal) {
			writeAPI(w, refusal.Status, refusal.Message, refusal.Code)
			return
		}
		writeAPI(w, http.StatusInternalServerError, "兑换失败", "INTERNAL")
		return
	}
	payload := map[string]any{
		"ok":           true,
		"plan":         map[string]string{"key": result.PlanKey, "name": result.PlanName},
		"member_seats": result.MemberSeats, "ocr_credits": int64(0), "wallet_cents": result.WalletCents,
		"replaced_lots": result.ReplacedLots, "replaced_seats": result.ReplacedSeats,
	}
	if result.PlanExpiresAt != nil {
		payload["plan_expires_at"] = RFC3339Millis(*result.PlanExpiresAt)
	}
	writeJSON(w, http.StatusOK, payload)
}

func resolve(resolver access.Resolver, r *http.Request) (*access.Principal, *access.Refusal, error) {
	if resolver == nil {
		return nil, nil, nil
	}
	return resolver.Resolve(r)
}

func writeAPI(w http.ResponseWriter, status int, message, code string) {
	writeJSON(w, status, map[string]string{"error": message, "code": code})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	raw, err := json.Marshal(body)
	if err != nil {
		http.Error(w, "兑换失败", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}
