package billinghttp

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	"github.com/xxww0098/podhub-go/internal/billing/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

const agreementVersion = "subscription-2026-10-21"
const agreementContent = "套餐从购买日起按月计算，店铺及成员加购与套餐统一续费。减少续费名额只改变尚未购买的期间，已付权益继续用满，本次调整不自动退款。到期后按保留名单暂停新操作，店铺配置和历史数据保留。提高已付期间容量按剩余服务时间补差。"

func (h handler) registerSubscription(r chi.Router) {
	r.Get("/api/billing/subscription", h.subscription)
	r.Post("/api/billing/quotes", h.subscriptionQuote)
	r.Post("/api/billing/schedule", h.subscriptionSchedule)
	r.Post("/api/billing/orders", h.subscriptionOrder)
	r.Get("/api/billing/orders/{public_id}", h.subscriptionOrderView)
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
	if errors.Is(err, service.ErrNoSubscription) {
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
	out, err := service.SubscriptionView(r.Context(), h.deps.Pool, p.OrgID, h.now())
	if err != nil {
		h.subscriptionError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, struct {
		contract.View
		Agreement map[string]string `json:"purchase_agreement"`
	}{out, map[string]string{"version": agreementVersion, "title": "订阅购买确认", "content": agreementContent, "effective_at": "2026-10-21"}})
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

	out, err := service.Quote(r.Context(), h.deps.Pool, p.OrgID, req, h.now())
	if err != nil {
		h.subscriptionError(w, err)
		return
	}
	writeJSON(w, 200, out)
}
func (h handler) subscriptionSchedule(w http.ResponseWriter, r *http.Request) {
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
	if err := service.ConfirmSchedule(r.Context(), h.deps.Pool, p.OrgID, req.QuoteID, req.CancelPending, h.now()); err != nil {
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
	now := h.now()
	agreement, _ := json.Marshal(map[string]string{"version": agreementVersion, "title": "订阅购买确认", "content": agreementContent, "effective_at": "2026-10-21", "accepted_at": now.Format("2006-01-02T15:04:05Z07:00"), "accepted_by": strconv.FormatInt(p.UserID, 10)})
	out, err := service.CreateSubscriptionOrder(r.Context(), h.deps.Pool, p.OrgID, p.UserID, "po_"+uuid.NewString(), "manual", "CNY", req.QuoteID, agreement, now)
	if err != nil {
		h.subscriptionError(w, err)
		return
	}
	writeJSON(w, 201, out)
}
func (h handler) subscriptionOrderView(w http.ResponseWriter, r *http.Request) {
	p := h.subscriptionActor(w, r, true)
	if p == nil {
		return
	}
	var out struct {
		PublicID  string          `json:"public_id"`
		Status    string          `json:"status"`
		Amount    int64           `json:"amount_cents"`
		Reason    *string         `json:"reconciliation_reason"`
		Agreement json.RawMessage `json:"purchase_agreement"`
	}
	err := db.InTx(r.Context(), h.deps.Pool, db.App(p.OrgID), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `SELECT public_id,status,amount_cents,reconciliation_reason,purchase_agreement FROM payment_orders WHERE org_id=$1 AND public_id=$2 AND product='subscription'`, p.OrgID, chi.URLParam(r, "public_id")).Scan(&out.PublicID, &out.Status, &out.Amount, &out.Reason, &out.Agreement)
	})
	if err != nil {
		h.subscriptionError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, out)
}
