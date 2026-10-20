package adminhttp

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/admin/service"
)

func (h handler) delegateAdmin(w http.ResponseWriter, r *http.Request, rt Route, s Session) {
	if st, msg, code := gateStaff(s); st != 0 {
		writeDelegateErr(w, st, msg, code)
		return
	}
	svc := depPtr[service.DelegateAdmin](h.Deps, "Delegate")
	if svc == nil {
		writeDelegateErr(w, http.StatusNotImplemented, "not_ported", "not_ported")
		return
	}
	q := r.URL.Query()
	switch rt.Method + " " + rt.Path {
	case http.MethodGet + " /api/admin/delegate-orders":
		body, err := svc.List(r.Context(), q.Get("state"), q.Get("sourceId"), q.Get("orgId"), q.Get("cursor"), q.Get("limit"))
		writeDelegateResult(w, body, err)
	case http.MethodGet + " /api/admin/delegate-orders/{order_id}":
		body, err := svc.Get(r.Context(), chi.URLParam(r, "order_id"))
		writeDelegateResult(w, body, err)
	case http.MethodPost + " /api/admin/delegate-orders/{order_id}/dispatch":
		writeDelegateCall(w, svc.Dispatch(chi.URLParam(r, "order_id")))
	case http.MethodPost + " /api/admin/delegate-orders/{order_id}/receipt":
		writeDelegateCall(w, svc.Receipt(chi.URLParam(r, "order_id")))
	case http.MethodPost + " /api/admin/delegate-orders/{order_id}/cancel":
		writeDelegateCall(w, svc.Cancel(chi.URLParam(r, "order_id")))
	default:
		writeDelegateErr(w, http.StatusNotImplemented, "not_ported", "not_ported")
	}
}

func gateStaff(s Session) (int, string, string) {
	if s.UserID == 0 {
		return http.StatusUnauthorized, "未登录", "auth_invalid"
	}
	if !domain.PlatformStaff(s.PlatformRole) {
		return http.StatusForbidden, "需要平台管理员权限", "forbidden"
	}
	return 0, "", ""
}

func writeDelegateCall(w http.ResponseWriter, err error) {
	if err == nil {
		writeDelegateErr(w, http.StatusNotImplemented, "not_ported", "not_ported")
		return
	}
	writeDelegateResult(w, nil, err)
}

func writeDelegateResult(w http.ResponseWriter, body any, err error) {
	if err != nil {
		if ae, ok := err.(*domain.APIError); ok {
			code := ae.Code
			if code == "" {
				code = "internal"
			}
			st := ae.Status
			if st == 0 {
				st = http.StatusInternalServerError
			}
			if ae.RetryAfter != "" {
				w.Header().Set("Retry-After", ae.RetryAfter)
			}
			writeDelegateErr(w, st, ae.Message, code)
			return
		}
		writeDelegateErr(w, http.StatusInternalServerError, "服务暂不可用", "internal")
		return
	}
	raw, err := domain.Marshal(body)
	if err != nil {
		writeDelegateErr(w, http.StatusInternalServerError, "服务暂不可用", "internal")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

func writeDelegateErr(w http.ResponseWriter, status int, message, code string) {
	raw, err := domain.Marshal(struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}{Error: message, Code: code})
	if err != nil {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}
