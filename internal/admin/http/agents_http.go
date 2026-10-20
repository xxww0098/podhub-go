package adminhttp

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/admin/service"
)

func (h handler) agents(w http.ResponseWriter, r *http.Request, rt Route, s Session) {
	if st, msg, code := gateSuper(s); st != 0 {
		writeShippingErr(w, st, msg, code)
		return
	}
	svc := depPtr[service.Agents](h.Deps, "Agents")
	if svc == nil {
		writeShippingErr(w, http.StatusNotImplemented, "not_ported", "not_ported")
		return
	}
	actor := domain.Actor{UserID: s.UserID, OrgID: s.OrgID, PublicID: s.PublicID}
	ctx := r.Context()
	switch rt.Method + " " + rt.Path {
	case http.MethodGet + " /api/admin/agent-commissions":
		status, page, size, err := commissionQuery(r)
		if err != nil {
			writeShippingAPI(w, err)
			return
		}
		body, err := svc.ListCommissions(ctx, status, page, size)
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodGet + " /api/admin/agent-commissions/csv":
		status, _, _, err := commissionQuery(r)
		if err != nil {
			writeShippingAPI(w, err)
			return
		}
		body, err := svc.ExportCommissions(ctx, status)
		if err != nil {
			writeShippingAPI(w, err)
			return
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="agent-commissions.csv"`)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	case http.MethodPut + " /api/admin/agent-rebate-policy":
		body, err := svc.SetPolicy(ctx, actor, rawBody(r))
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodGet + " /api/admin/agent-withdrawals":
		status, err := withdrawalQuery(r)
		if err != nil {
			writeShippingAPI(w, err)
			return
		}
		body, err := svc.ListWithdrawals(ctx, status)
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodPost + " /api/admin/agent-withdrawals/{public_id}/pay":
		body, err := svc.Pay(ctx, actor, chi.URLParam(r, "public_id"), rawBody(r))
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodPost + " /api/admin/agent-withdrawals/{public_id}/reject":
		body, err := svc.Reject(ctx, actor, chi.URLParam(r, "public_id"), rawBody(r))
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodGet + " /api/admin/agents":
		query, status, flagged, err := agentQuery(r)
		if err != nil {
			writeShippingAPI(w, err)
			return
		}
		body, err := svc.List(ctx, actor, query, status, flagged)
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodPost + " /api/admin/agents":
		body, err := svc.Create(ctx, actor, rawBody(r))
		writeShippingResult(w, http.StatusCreated, body, err)
	case http.MethodPut + " /api/admin/agents/{uuid}":
		body, err := svc.Update(ctx, actor, chi.URLParam(r, "uuid"), rawBody(r))
		writeShippingResult(w, http.StatusOK, body, err)
	default:
		writeShippingErr(w, http.StatusNotImplemented, "not_ported", "not_ported")
	}
}

func trimmedQuery(r *http.Request, key string) *string {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return nil
	}
	return &raw
}

func commissionQuery(r *http.Request) (*string, int64, int64, error) {
	q := r.URL.Query()
	page := int64(1)
	size := int64(50)
	// page=abc is an axum Query rejection. That JSON body is unconfirmed, so this is the domain envelope.
	if q.Has("page") {
		n, err := strconv.ParseInt(q.Get("page"), 10, 64)
		if err != nil {
			return nil, 0, 0, domain.Fail(400, "VALIDATION", "请求格式无效")
		}
		page = n
	}
	if q.Has("page_size") {
		n, err := strconv.ParseInt(q.Get("page_size"), 10, 64)
		if err != nil {
			return nil, 0, 0, domain.Fail(400, "VALIDATION", "请求格式无效")
		}
		size = n
	}
	return trimmedQuery(r, "status"), page, size, nil
}

func withdrawalQuery(r *http.Request) (*string, error) {
	raw := r.URL.Query().Get("status")
	status, ok, err := domain.WithdrawalStatus(raw)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	return &status, nil
}

func agentQuery(r *http.Request) (*string, *string, bool, error) {
	q := r.URL.Query()
	flagged := false
	if q.Has("flagged") {
		// flagged=not-bool is an axum Query rejection. That JSON body is unconfirmed, so this is the domain envelope.
		switch q.Get("flagged") {
		case "true":
			flagged = true
		case "false":
			flagged = false
		default:
			return nil, nil, false, domain.Fail(400, "VALIDATION", "请求格式无效")
		}
	}
	return trimmedQuery(r, "query"), trimmedQuery(r, "status"), flagged, nil
}
