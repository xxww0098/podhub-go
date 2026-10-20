// Package opshttp mounts the ops routes. It does not import the repo.
package opshttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
	"github.com/xxww0098/podhub-go/internal/ops/domain"
	"github.com/xxww0098/podhub-go/internal/ops/service"
)

const (
	msgUnauthenticated = "未登录"
	msgNoWorkspace     = "当前账号尚未加入任何工作空间，请先创建工作空间，或等待他人邀请后在通知中接受"
	msgUnavailable     = "服务暂不可用"
	requestTimeout     = 120 * time.Second
	maxBody            = 2<<20 + 1
)

// Session is the caller the assembly layer already resolved.
type Session struct {
	UserID        int64
	OrgID         int64
	WorkspaceRole string
	PlatformRole  string
}

// Refusal is an authentication answer. Status is the HTTP status.
type Refusal struct {
	Status  int
	Message string
}

// Resolve answers one request. A non-nil Refusal wins. A nil session and a
// nil refusal means logged out.
type Resolve func(*http.Request) (*Session, *Refusal, error)

// Deps is the mount input.
type Deps struct {
	Resolve Resolve
	Screen  *service.Screen
}

// Mount registers every route. Registration order follows the table.
func Mount(r chi.Router, d Deps) {
	if r == nil {
		return
	}
	h := handler{Deps: d}
	for _, rt := range Routes() {
		rt := rt
		r.Method(rt.Method, rt.Path, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			h.serve(w, req, rt)
		}))
	}
}

type handler struct{ Deps }

func (h handler) serve(w http.ResponseWriter, r *http.Request, rt Route) {
	body, tooBig := readBody(r)
	if tooBig {
		writeOps(w, contract.NotPorted())
		return
	}
	if rt.Path == "/api/ops/products/promotions" {
		if req, err := domain.DecodePromotions(body); err == nil && len(domain.PositiveProducts(req.ProductIDs)) == 0 {
			writeRaw(w, http.StatusOK, domain.EmptyPromotions())
			return
		}
	}
	p, ok := principal(w, r, h.Resolve)
	if !ok {
		return
	}
	actor := service.Actor{UserID: p.UserID, OrgID: p.OrgID, Role: p.WorkspaceRole}
	if h.Screen == nil {
		writeOps(w, contract.NotPorted())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	raw, fail := h.dispatch(ctx, actor, rt, body)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		writeCloud(w, http.StatusGatewayTimeout, contract.CodeInternal, "请求处理超时")
		return
	}
	if fail != nil {
		writeOps(w, fail)
		return
	}
	writeRaw(w, http.StatusOK, raw)
}

func (h handler) dispatch(ctx context.Context, a service.Actor, rt Route, body []byte) (json.RawMessage, *contract.Fail) {
	switch rt.Path {
	case "/api/ops/shipping/list":
		return h.Screen.Shipping(ctx, a, body)
	case "/api/ops/returns/list":
		return h.Screen.Returns(ctx, a, body)
	case "/api/ops/returns/cancellations":
		return h.Screen.Cancellations(ctx, a, body)
	case "/api/ops/voice/reviews":
		return h.Screen.Reviews(ctx, a, body)
	case "/api/ops/voice/questions":
		return h.Screen.Questions(ctx, a, body)
	case "/api/ops/supply/orders":
		return h.Screen.SupplyOrders(ctx, a, body)
	case "/api/ops/supply/warehouse-stocks":
		return h.Screen.SupplyStocks(ctx, a, body)
	case "/api/ops/message-center/inbox":
		return h.Screen.Inbox(ctx, a, body)
	case "/api/ops/message-center/history":
		return h.Screen.History(ctx, a, body)
	case "/api/ops/message-center/send":
		return h.Screen.Send(ctx, a, body)
	case "/api/ops/products/sync":
		return h.Screen.Sync(ctx, a, body)
	case "/api/ops/products/metrics":
		return h.Screen.Metrics(ctx, a, body)
	case "/api/ops/products/warehouses":
		return h.Screen.Warehouses(ctx, a, body)
	case "/api/ops/products/promotions":
		return h.Screen.Promotions(ctx, a, body)
	case "/api/ops/products/mutate":
		return h.Screen.Mutate(ctx, a, body)
	case "/api/ops/console/snapshot":
		return h.Screen.Snapshot(ctx, a)
	case "/api/ops/console/refresh-metrics":
		return h.Screen.RefreshMetrics(ctx, a)
	case "/api/ops/console/reconcile":
		return h.Screen.Reconcile(ctx, a)
	default:
		return nil, contract.NotPorted()
	}
}

func readBody(r *http.Request) ([]byte, bool) {
	if r.Body == nil {
		return nil, false
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return nil, true
	}
	return raw, len(raw) > maxBody
}

func principal(w http.ResponseWriter, r *http.Request, resolve Resolve) (Session, bool) {
	if resolve == nil {
		writeOps(w, &contract.Fail{Status: http.StatusUnauthorized, Code: contract.CodeAuthRequired, Message: msgUnauthenticated})
		return Session{}, false
	}
	p, refusal, err := resolve(r)
	if err != nil {
		writeOps(w, contract.Internal(msgUnavailable))
		return Session{}, false
	}
	if refusal != nil {
		code := contract.CodeForbidden
		if refusal.Status == http.StatusUnauthorized {
			code = contract.CodeAuthRequired
		}
		if refusal.Status >= 500 {
			code = contract.CodeInternal
		}
		writeOps(w, &contract.Fail{Status: refusal.Status, Code: code, Message: refusal.Message})
		return Session{}, false
	}
	if p == nil {
		writeOps(w, &contract.Fail{Status: http.StatusUnauthorized, Code: contract.CodeAuthRequired, Message: msgUnauthenticated})
		return Session{}, false
	}
	return *p, true
}

func writeOps(w http.ResponseWriter, f *contract.Fail) {
	if f == nil {
		f = contract.Internal("")
	}
	if f.RetryAfter != "" {
		w.Header().Set("Retry-After", f.RetryAfter)
	}
	raw, err := encode(struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}{Error: f.Message, Code: f.Code})
	if err != nil {
		writeCloud(w, http.StatusInternalServerError, contract.CodeInternal, msgUnavailable)
		return
	}
	writeRaw(w, f.Status, raw)
}

func writeCloud(w http.ResponseWriter, status int, code, message string) {
	raw, err := encode(struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{Code: code, Message: message})
	if err != nil {
		http.Error(w, msgUnavailable, http.StatusInternalServerError)
		return
	}
	writeRaw(w, status, raw)
}

func writeRaw(w http.ResponseWriter, status int, raw []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if _, err := w.Write(raw); err != nil {
		slog.Error("json write", "err", err)
	}
}

func encode(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
