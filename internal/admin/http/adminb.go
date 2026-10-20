package adminhttp

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

type wireFamily int

const (
	famAdmin wireFamily = iota
	famIntegration
	famAI
	famOps
	famTelemetry
)

func adminBRoute(rt Route) bool {
	switch rt.Path {
	case "/api/admin/plans", "/api/admin/orders",
		"/api/admin/orders/{public_id}/confirm", "/api/admin/orders/{public_id}/cancel",
		"/api/admin/redeem-codes",
		"/api/admin/payment/config",
		"/api/admin/workspaces/{uuid}/wallet", "/api/admin/workspaces/{uuid}/wallet/topups",
		"/api/admin/workspaces/{uuid}/wallet/topups/{topup_id}/revoke",
		"/api/admin/ops/scopes", "/api/admin/ops/console/snapshot",
		"/api/admin/stores/products", "/api/admin/stores/products/overview",
		"/api/admin/stores/{store_id}/products/{store_product_id}/thumbnail",
		"/api/admin/error-logs":
		return true
	default:
		return false
	}
}

func billingFamily(path string) wireFamily {
	switch {
	case strings.Contains(path, "/payment/config"):
		return famIntegration
	case strings.Contains(path, "/wallet"):
		return famAI
	case strings.Contains(path, "/ops/") || strings.Contains(path, "/stores/"):
		return famOps
	case strings.Contains(path, "/error-logs"), strings.Contains(path, "/error-digest"), strings.Contains(path, "/ozon-error-catalog"):
		return famTelemetry
	default:
		return famAdmin
	}
}

func (h handler) serveAdminB(w http.ResponseWriter, r *http.Request, rt Route) {
	fam := billingFamily(rt.Path)
	if fam == famOps {
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("Vary", "Cookie, Authorization")
	}
	if domain.CrossOriginWrite(r.Method, r.Header.Get("Cookie"), r.Header.Get("Sec-Fetch-Site"), r.Header.Get("Origin"), r.Host) {
		writeCloud(w, http.StatusForbidden, "csrf_rejected", "跨站请求已被拒绝")
		return
	}
	if rt.Path == "/api/admin/redeem-codes/{id}" || rt.Path == "/api/admin/redeem-codes/{id}/revoke" {
		raw := pathSegment(chi.URLParam(r, "id"))
		if _, ok := rustParseI64(raw); !ok {
			writePlain(w, http.StatusBadRequest, "Invalid URL: Cannot parse `"+raw+"` to a `i64`")
			return
		}
	}
	session, ok := h.gate(w, r, fam)
	if !ok {
		return
	}
	if !domain.SuperAdmin(session.PlatformRole) {
		h.writeFamily(w, fam, http.StatusForbidden, "需要超级管理员权限")
		return
	}
	token := rawToken(r)
	standing, err := h.AdminB.Standing(r.Context(), session.UserID, domain.SessionHash(token))
	if err != nil {
		h.writeFault(w, fam, err)
		return
	}
	if standing.Missing {
		h.writeFamily(w, fam, http.StatusInternalServerError, msgUnavailable)
		return
	}
	if !standing.Enrolled {
		h.writeFamily(w, fam, http.StatusForbidden, "请先绑定验证器")
		return
	}
	if !standing.Elevated {
		h.writeFamily(w, fam, http.StatusForbidden, "管理操作需要重新验证")
		return
	}
	publicID, err := h.AdminB.PublicID(r.Context(), session.UserID)
	if err != nil {
		h.writeFault(w, fam, err)
		return
	}
	actor := domain.Actor{UserID: session.UserID, OrgID: session.OrgID, PublicID: publicID}
	run := func(body []byte, err error) { h.reply(w, fam, body, err) }
	switch rt.Method + " " + rt.Path {
	case "GET /api/admin/plans":
		run(h.AdminB.ListPlans(r.Context(), actor))
	case "GET /api/admin/orders":
		run(h.AdminB.ListOrders(r.Context(), actor))
	case "GET /api/admin/orders/{public_id}":
		run(h.AdminB.GetOrder(r.Context(), actor, chi.URLParam(r, "public_id")))
	case "PUT /api/admin/orders/{public_id}/confirm":
		run(h.AdminB.ConfirmOrder(r.Context(), actor, chi.URLParam(r, "public_id")))
	case "POST /api/admin/orders/{public_id}/cancel":
		run(h.AdminB.CancelOrder(r.Context(), actor, chi.URLParam(r, "public_id")))
	case "GET /api/admin/redeem-codes":
		run(h.AdminB.ListRedeem(r.Context(), actor))
	case "POST /api/admin/redeem-codes":
		spec, ok := decodeRedeem(w, r)
		if ok {
			body, err := h.AdminB.CreateRedeem(r.Context(), actor, spec)
			h.replyStatus(w, fam, http.StatusCreated, body, err)
		}
	case "GET /api/admin/redeem-codes/{id}":
		id, ok := pathI64(w, chi.URLParam(r, "id"))
		if ok {
			run(h.AdminB.GetRedeem(r.Context(), actor, id))
		}
	case "DELETE /api/admin/redeem-codes/{id}":
		id, ok := pathI64(w, chi.URLParam(r, "id"))
		if ok {
			run(h.AdminB.DeleteRedeem(r.Context(), actor, id))
		}
	case "POST /api/admin/redeem-codes/{id}/revoke":
		id, ok := pathI64(w, chi.URLParam(r, "id"))
		if ok {
			run(h.AdminB.RevokeRedeem(r.Context(), actor, id))
		}
	case "GET /api/admin/payment/config":
		run(h.AdminB.GetPayment(r.Context(), actor))
	case "PUT /api/admin/payment/config":
		body, ok := decodePayment(w, r)
		if ok {
			run(h.AdminB.PutPayment(r.Context(), actor, body))
		}
	case "GET /api/admin/workspaces/{uuid}/wallet":
		run(h.AdminB.Wallet(r.Context(), actor, chi.URLParam(r, "uuid")))
	case "POST /api/admin/workspaces/{uuid}/wallet/topups":
		grant, ok := decodeTopup(w, r, chi.URLParam(r, "uuid"))
		if ok {
			run(h.AdminB.GrantTopup(r.Context(), actor, grant))
		}
	case "POST /api/admin/workspaces/{uuid}/wallet/topups/{topup_id}/revoke":
		id := chi.URLParam(r, "topup_id")
		if !domain.OperationID(id) {
			h.writeFamily(w, fam, http.StatusBadRequest, "充值记录无效")
			return
		}
		run(h.AdminB.RevokeTopup(r.Context(), actor, chi.URLParam(r, "uuid"), id))
	case "GET /api/admin/ops/scopes":
		scope, ok := decodeScope(w, r, false)
		if ok {
			run(h.AdminB.Scopes(r.Context(), actor, scope))
		}
	case "GET /api/admin/ops/console/snapshot":
		scope, ok := decodeScope(w, r, false)
		if ok {
			run(h.AdminB.Snapshot(r.Context(), actor, scope))
		}
	case "GET /api/admin/stores/products/overview":
		scope, ok := decodeScope(w, r, false)
		if ok {
			run(h.AdminB.Overview(r.Context(), actor, scope))
		}
	case "GET /api/admin/stores/products":
		query, ok := decodeProducts(w, r)
		if ok {
			run(h.AdminB.Products(r.Context(), actor, query))
		}
	case "GET /api/admin/stores/{store_id}/products/{store_product_id}/thumbnail":
		img, err := h.AdminB.Thumbnail(r.Context(), actor, domain.Thumbnail{
			StoreID: chi.URLParam(r, "store_id"), ProductID: chi.URLParam(r, "store_product_id"),
		})
		if err != nil {
			h.writeFault(w, fam, err)
			return
		}
		w.Header().Set("Content-Type", img.Type)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(img.Body)
	case "GET /api/admin/error-logs":
		filter, ok := decodeErrorQuery(w, r)
		if ok {
			run(h.AdminB.ListErrors(r.Context(), actor, filter))
		}
	case "DELETE /api/admin/error-logs":
		body, ok := decodeErrorDelete(w, r)
		if ok {
			run(h.AdminB.DeleteErrors(r.Context(), actor, body))
		}
	default:
		writeErr(w, http.StatusNotImplemented, "not_ported", "not_ported")
	}
}

func (h handler) gate(w http.ResponseWriter, r *http.Request, fam wireFamily) (Session, bool) {
	if h.Resolve == nil {
		h.writeFamily(w, fam, http.StatusUnauthorized, msgUnauthenticated)
		return Session{}, false
	}
	p, refusal, err := h.Resolve(r)
	if err != nil {
		h.writeFamily(w, fam, http.StatusInternalServerError, msgUnavailable)
		return Session{}, false
	}
	if refusal != nil {
		if fam == famIntegration && refusal.Status != http.StatusUnauthorized && refusal.Status != http.StatusForbidden {
			h.writeFamily(w, fam, http.StatusInternalServerError, msgUnavailable)
			return Session{}, false
		}
		h.writeFamily(w, fam, refusal.Status, refusal.Message)
		return Session{}, false
	}
	if p == nil {
		h.writeFamily(w, fam, http.StatusUnauthorized, msgUnauthenticated)
		return Session{}, false
	}
	return *p, true
}

func (h handler) writeFamily(w http.ResponseWriter, fam wireFamily, status int, message string) {
	writeErr(w, status, message, familyCode(fam, status))
}

func familyCode(fam wireFamily, status int) string {
	switch fam {
	case famOps:
		switch status {
		case http.StatusUnauthorized:
			return "auth_required"
		case http.StatusForbidden:
			return "forbidden"
		case http.StatusBadRequest:
			return "validation"
		case http.StatusNotFound:
			return "not_found"
		default:
			return "internal"
		}
	case famAI, famTelemetry:
		if status == http.StatusUnauthorized {
			return "AUTH_REQUIRED"
		}
		if status == http.StatusForbidden {
			return "FORBIDDEN"
		}
		if status == http.StatusBadRequest {
			return "VALIDATION"
		}
		return "INTERNAL"
	default:
		if status == http.StatusUnauthorized {
			return "AUTH_INVALID"
		}
		if status == http.StatusForbidden {
			return "FORBIDDEN"
		}
		if status == http.StatusBadRequest {
			return "VALIDATION"
		}
		return "INTERNAL"
	}
}

func (h handler) reply(w http.ResponseWriter, fam wireFamily, body []byte, err error) {
	h.replyStatus(w, fam, http.StatusOK, body, err)
}

func (h handler) replyStatus(w http.ResponseWriter, fam wireFamily, status int, body []byte, err error) {
	if err != nil {
		h.writeFault(w, fam, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func (h handler) writeFault(w http.ResponseWriter, fam wireFamily, err error) {
	fault, ok := err.(*domain.Fault)
	if !ok {
		h.writeFamily(w, fam, http.StatusInternalServerError, msgUnavailable)
		return
	}
	if fault.Code == "not_ported" {
		writeErr(w, http.StatusNotImplemented, "not_ported", "not_ported")
		return
	}
	status := http.StatusInternalServerError
	switch fault.Kind {
	case "validation":
		status = http.StatusBadRequest
	case "conflict":
		status = http.StatusConflict
	case "not_found":
		status = http.StatusNotFound
	case "forbidden":
		status = http.StatusForbidden
	case "writes_disabled", "unavailable":
		status = http.StatusServiceUnavailable
	case "upstream":
		status = http.StatusBadGateway
	case "locked":
		status = http.StatusServiceUnavailable
		w.Header().Set("Retry-After", "1")
	}
	code := fault.Code
	if code == "" {
		code = familyCode(fam, status)
	}
	writeErr(w, status, fault.Message, code)
}

func writeCloud(w http.ResponseWriter, status int, code, message string) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{code, message})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(bytes.TrimRight(buf.Bytes(), "\n"))
}

func rawToken(r *http.Request) string {
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
		if token != "" {
			return token
		}
	}
	cookie, err := r.Cookie("sid")
	if err == nil {
		return cookie.Value
	}
	return ""
}

func pathSegment(raw string) string {
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		return raw
	}
	return decoded
}

func rustParseI64(raw string) (int64, bool) {
	if strings.HasPrefix(raw, "+") {
		return 0, false
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, false
	}
	return id, true
}

func pathI64(w http.ResponseWriter, raw string) (int64, bool) {
	raw = pathSegment(raw)
	id, ok := rustParseI64(raw)
	if !ok {
		writePlain(w, http.StatusBadRequest, "Invalid URL: Cannot parse `"+raw+"` to a `i64`")
		return 0, false
	}
	return id, true
}

func writePlain(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func readJSON(w http.ResponseWriter, r *http.Request, dest any) bool {
	dec := json.NewDecoder(io.LimitReader(r.Body, 2<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dest); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
		return false
	}
	return true
}

func decodeRedeem(w http.ResponseWriter, r *http.Request) (domain.RedeemSpec, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
		return domain.RedeemSpec{}, false
	}
	spec, fault := domain.ParseRedeemBody(body, time.Now())
	if fault != nil {
		writeErr(w, faultStatus(fault), fault.Message, fault.Code)
		return domain.RedeemSpec{}, false
	}
	return spec, true
}

func decodePayment(w http.ResponseWriter, r *http.Request) (domain.PaymentReplace, bool) {
	var body struct {
		Expected  *int64 `json:"expectedRevision"`
		Providers []struct {
			Provider string            `json:"provider"`
			Enabled  bool              `json:"enabled"`
			Values   map[string]string `json:"values"`
		} `json:"providers"`
	}
	if !readJSON(w, r, &body) {
		return domain.PaymentReplace{}, false
	}
	if body.Expected == nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
		return domain.PaymentReplace{}, false
	}
	slots := make([]domain.PaymentSlot, 0, len(body.Providers))
	for _, slot := range body.Providers {
		values := slot.Values
		if values == nil {
			values = map[string]string{}
		}
		slots = append(slots, domain.PaymentSlot{Provider: slot.Provider, Enabled: slot.Enabled, Values: values})
	}
	return domain.PaymentReplace{Expected: *body.Expected, Slots: slots}, true
}

func decodeTopup(w http.ResponseWriter, r *http.Request, workspace string) (domain.TopupGrant, bool) {
	var body struct {
		OperationID *string `json:"operation_id"`
		AmountCents *int64  `json:"amount_cents"`
		Note        string  `json:"note"`
	}
	if !readJSON(w, r, &body) {
		return domain.TopupGrant{}, false
	}
	if body.OperationID == nil || body.AmountCents == nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
		return domain.TopupGrant{}, false
	}
	if !domain.OperationID(*body.OperationID) {
		writeErr(w, http.StatusBadRequest, "充值操作编号无效", "VALIDATION")
		return domain.TopupGrant{}, false
	}
	if *body.AmountCents < 1 || *body.AmountCents > 1_000_000 {
		writeErr(w, http.StatusBadRequest, "充值金额需在 1 到 1000000 分之间", "VALIDATION")
		return domain.TopupGrant{}, false
	}
	return domain.TopupGrant{WorkspaceUUID: workspace, OperationID: *body.OperationID, AmountCents: *body.AmountCents, Note: domain.NoteClip(body.Note)}, true
}

func decodeScope(w http.ResponseWriter, r *http.Request, products bool) (domain.Scope, bool) {
	allowed := map[string]bool{"workspaceId": true, "storeId": true}
	if products {
		allowed["status"] = true
		allowed["q"] = true
		allowed["includeGone"] = true
		allowed["cursor"] = true
		allowed["limit"] = true
	}
	for key := range r.URL.Query() {
		if !allowed[key] {
			writeErr(w, http.StatusBadRequest, "查询参数无效", "validation")
			return domain.Scope{}, false
		}
	}
	return domain.Scope{WorkspaceID: r.URL.Query().Get("workspaceId"), StoreID: r.URL.Query().Get("storeId")}, true
}

func decodeProducts(w http.ResponseWriter, r *http.Request) (domain.ProductQuery, bool) {
	scope, ok := decodeScope(w, r, true)
	if !ok {
		return domain.ProductQuery{}, false
	}
	query := domain.ProductQuery{Scope: scope, Status: r.URL.Query().Get("status"), Q: r.URL.Query().Get("q"), Cursor: r.URL.Query().Get("cursor")}
	if raw := r.URL.Query().Get("includeGone"); raw != "" {
		switch raw {
		case "true":
			query.IncludeGone = true
		case "false":
			query.IncludeGone = false
		default:
			writeErr(w, http.StatusBadRequest, "查询参数无效", "validation")
			return domain.ProductQuery{}, false
		}
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "查询参数无效", "validation")
			return domain.ProductQuery{}, false
		}
		query.Limit = &n
	}
	return query, true
}

func decodeErrorQuery(w http.ResponseWriter, r *http.Request) (domain.ErrorFilter, bool) {
	raw := map[string]string{}
	for key, values := range r.URL.Query() {
		if len(values) > 0 {
			raw[key] = values[0]
		}
	}
	query, fault := domain.ValidateErrorQuery(raw)
	if fault != nil {
		writeErr(w, http.StatusBadRequest, fault.Message, "VALIDATION")
		return domain.ErrorFilter{}, false
	}
	return domain.ErrorFilter{Query: query}, true
}

func decodeErrorDelete(w http.ResponseWriter, r *http.Request) (domain.ErrorDelete, bool) {
	var body struct {
		Events []struct {
			EventID   string `json:"event_id"`
			DeviceUID string `json:"device_uid"`
		} `json:"events"`
	}
	if !readJSON(w, r, &body) {
		return domain.ErrorDelete{}, false
	}
	events := make([][2]string, 0, len(body.Events))
	for _, event := range body.Events {
		events = append(events, [2]string{event.EventID, event.DeviceUID})
	}
	if fault := domain.DeleteKeys(events); fault != nil {
		writeErr(w, http.StatusBadRequest, fault.Message, "VALIDATION")
		return domain.ErrorDelete{}, false
	}
	return domain.ErrorDelete{Events: events}, true
}

func faultStatus(fault *domain.Fault) int {
	if fault.Kind == "validation" {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}
