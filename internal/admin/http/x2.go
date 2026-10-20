package adminhttp

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"bytes"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	delegatec "github.com/xxww0098/podhub-go/internal/delegate/contract"
)

const x2BodyLimit = 2 * 1024 * 1024

func (h handler) x2Wired(rt Route) bool {
	return strings.Contains(rt.Path, "/delegate-orders/") && h.DelegateWrites != nil
}

func x2Route(rt Route) bool {
	switch rt.Method + " " + rt.Path {
	case "POST /api/admin/delegate-orders/{order_id}/dispatch",
		"POST /api/admin/delegate-orders/{order_id}/receipt",
		"POST /api/admin/delegate-orders/{order_id}/cancel":
		return true
	default:
		return false
	}
}

func (h handler) serveX2(w http.ResponseWriter, r *http.Request, rt Route) {
	p, ok := h.x2Principal(w, r)
	if !ok {
		return
	}
	now := time.Now().UnixMilli()
	var (
		raw json.RawMessage
		err error
	)
	switch rt.Method + " " + rt.Path {
	case "POST /api/admin/delegate-orders/{order_id}/dispatch":
		body, ok := x2Body(w, r, true)
		if !ok {
			return
		}
		if h.DelegateWrites == nil {
			x2Fail(w, delegatec.Internal())
			return
		}
		raw, err = h.DelegateWrites.Dispatch(r.Context(), p.UserID, chi.URLParam(r, "order_id"), body, now)
	case "POST /api/admin/delegate-orders/{order_id}/receipt":
		body, ok := x2Body(w, r, true)
		if !ok {
			return
		}
		if h.DelegateWrites == nil {
			x2Fail(w, delegatec.Internal())
			return
		}
		raw, err = h.DelegateWrites.Receipt(r.Context(), p.UserID, chi.URLParam(r, "order_id"), body, now)
	case "POST /api/admin/delegate-orders/{order_id}/cancel":
		if h.DelegateWrites == nil {
			x2Fail(w, delegatec.Internal())
			return
		}
		raw, err = h.DelegateWrites.Cancel(r.Context(), p.UserID, chi.URLParam(r, "order_id"), now)
	default:
		writeErr(w, http.StatusNotImplemented, "not_ported", "not_ported")
		return
	}
	if err != nil {
		x2Fail(w, err)
		return
	}
	x2JSON(w, http.StatusOK, raw)
}

// x2Principal is the delegate X2 gate: any signed-in platform staff.
func (h handler) x2Principal(w http.ResponseWriter, r *http.Request) (Session, bool) {
	if h.Resolve == nil {
		x2Fail(w, delegatec.Unauthenticated(""))
		return Session{}, false
	}
	p, refusal, err := h.Resolve(r)
	if err != nil {
		x2Fail(w, delegatec.Internal())
		return Session{}, false
	}
	if refusal != nil {
		if refusal.Status == http.StatusUnauthorized {
			x2Fail(w, delegatec.Unauthenticated(refusal.Message))
			return Session{}, false
		}
		x2Fail(w, delegatec.Internal())
		return Session{}, false
	}
	if p == nil || p.UserID == 0 {
		x2Fail(w, delegatec.Unauthenticated(""))
		return Session{}, false
	}
	if !domain.PlatformStaff(p.PlatformRole) {
		x2Fail(w, delegatec.Forbidden("需要平台管理员权限"))
		return Session{}, false
	}
	return *p, true
}

// x2Body reads one strict JSON body under x2BodyLimit. An empty body is
// refused when the route carries one.
func x2Body(w http.ResponseWriter, r *http.Request, required bool) ([]byte, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, x2BodyLimit+1))
	if err != nil || len(body) > x2BodyLimit {
		x2Fail(w, delegatec.Validation(delegatec.MsgInvalidJSON))
		return nil, false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		if !required {
			return nil, true
		}
		x2Fail(w, delegatec.Validation(delegatec.MsgInvalidJSON))
		return nil, false
	}
	if !json.Valid(body) {
		x2Fail(w, delegatec.Validation(delegatec.MsgInvalidJSON))
		return nil, false
	}
	return body, true
}

// x2Fail writes one delegate contract failure. Locked carries Retry-After.
func x2Fail(w http.ResponseWriter, err error) {
	var api *delegatec.APIError
	if errors.As(err, &api) {
		for key, value := range api.Headers {
			w.Header().Set(key, value)
		}
		x2Error(w, api.Status, api.Code, api.Message)
		return
	}
	x2Error(w, http.StatusInternalServerError, "internal", delegatec.MsgUnavailable)
}

func x2Error(w http.ResponseWriter, status int, code, message string) {
	raw, err := json.Marshal(struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}{Error: message, Code: code})
	if err != nil {
		http.Error(w, delegatec.MsgUnavailable, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func x2JSON(w http.ResponseWriter, status int, raw json.RawMessage) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}
