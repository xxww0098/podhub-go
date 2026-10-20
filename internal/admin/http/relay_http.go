package adminhttp

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/admin/service"
)

func (h handler) relay(w http.ResponseWriter, r *http.Request, rt Route, s Session) {
	if st, msg, code := gateSuper(s); st != 0 {
		writeRelayErr(w, st, msg, code)
		return
	}
	svc := depPtr[service.Relay](h.Deps, "Relay")
	if svc == nil {
		writeRelayErr(w, http.StatusNotImplemented, "not_ported", "not_ported")
		return
	}
	actor := domain.Actor{UserID: s.UserID, OrgID: s.OrgID, PublicID: sessionString(s, "PublicID")}
	switch rt.Method + " " + rt.Path {
	case http.MethodGet + " /api/admin/seller-relay":
		body, err := svc.Get()
		writeRelayResult(w, body, err)
	case http.MethodPost + " /api/admin/seller-relay/nodes":
		body, err := svc.Import(r.Context(), actor, rawBody(r))
		writeRelayResult(w, body, err)
	case http.MethodPut + " /api/admin/seller-relay/active":
		body, err := svc.Switch(r.Context(), actor, rawBody(r))
		writeRelayResult(w, body, err)
	case http.MethodDelete + " /api/admin/seller-relay/nodes/{node_id}":
		body, err := svc.Delete(r.Context(), actor, chi.URLParam(r, "node_id"))
		writeRelayResult(w, body, err)
	case http.MethodPost + " /api/admin/seller-relay/probe":
		body, err := svc.Probe()
		writeRelayResult(w, body, err)
	default:
		writeRelayErr(w, http.StatusNotImplemented, "not_ported", "not_ported")
	}
}

func writeRelayResult(w http.ResponseWriter, body any, err error) {
	if err != nil {
		if ae, ok := err.(*domain.APIError); ok {
			code := ae.Code
			if code == "" {
				code = "INTERNAL"
			}
			st := ae.Status
			if st == 0 {
				st = http.StatusInternalServerError
			}
			writeRelayErr(w, st, ae.Message, code)
			return
		}
		writeRelayErr(w, http.StatusInternalServerError, "服务暂不可用", "INTERNAL")
		return
	}
	raw, err := domain.Marshal(body)
	if err != nil {
		writeRelayErr(w, http.StatusInternalServerError, "服务暂不可用", "INTERNAL")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

func writeRelayErr(w http.ResponseWriter, status int, message, code string) {
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
