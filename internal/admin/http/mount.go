// Package adminhttp mounts platform admin, supplier admin, and platform
// catalog routes. Banned-tag routes are not registered here.
package adminhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/admin/service"
)

const (
	msgUnauthenticated = "未登录"
	msgNoWorkspace     = "当前账号尚未加入任何工作空间，请先创建工作空间，或等待他人邀请后在通知中接受"
	msgUnavailable     = "服务暂不可用"
	msgSuperAdmin      = "需要超级管理员权限"
)

// Session is the caller the assembly layer already resolved.
// TotpEnrolled and StepUpElevated are the super-admin gate. PublicID is
// account_users.public_id. Staff routes ignore the TOTP fields.
type Session struct {
	UserID         int64
	OrgID          int64
	WorkspaceRole  string
	PlatformRole   string
	Email          string
	PublicID       string
	TokenHash      string
	TotpEnrolled   bool
	StepUpElevated bool
}

// Refusal is an authentication answer. Status is the HTTP status.
type Refusal struct {
	Status  int
	Message string
}

// Resolve answers one request. A non-nil Refusal wins. A nil session and a
// nil refusal means logged out.
type Resolve func(*http.Request) (*Session, *Refusal, error)

// DelegateWrites is dispatch, receipt, and cancel. The app adapts the delegate service.
// A nil port leaves those three routes on the platform 501 path.
type DelegateWrites interface {
	Dispatch(ctx context.Context, userID int64, orderID string, body []byte, nowMS int64) (json.RawMessage, error)
	Receipt(ctx context.Context, userID int64, orderID string, body []byte, nowMS int64) (json.RawMessage, error)
	Cancel(ctx context.Context, userID int64, orderID string, nowMS int64) (json.RawMessage, error)
}

// ShippingWrites is reconcile and safe-continue. The app adapts the shipping service.
// A nil port leaves those two routes on the platform 501 path.
type ShippingWrites interface {
	Reconcile(ctx context.Context, storeUUID, presetID string, now int64) (json.RawMessage, error)
	SafeContinue(ctx context.Context, storeUUID, presetID, actor string, now int64) (json.RawMessage, error)
}

// Deps is the session resolver, billing, supplier admin, the users and
// AI-auth API, already-ported handlers, and platform services.
// Ported, when set, serves a method and path before the route guard.
// A nil map leaves those routes at 501.
// A nil AdminB leaves billing and observation routes on the shared guard, then 501.
// A nil API keeps the users and AI-auth routes on the 501 body.
// A nil Supplier keeps implemented supplier routes at 500.
// A nil platform service keeps that route at 501.
// DelegateWrites and ShippingWrites, when set, replace the 501 stubs for the five X2 writes.
type Deps struct {
	Resolve        Resolve
	AdminB         service.BillingAPI
	Supplier       *service.Service
	Ported         map[string]http.HandlerFunc
	API            *service.API
	Catalog        *service.Catalog
	Procure        *service.Procure
	Agents         *service.Agents
	Shipping       *service.Shipping
	Relay          *service.Relay
	Delegate       *service.DelegateAdmin
	DelegateWrites DelegateWrites
	ShippingWrites ShippingWrites
}

// Mount registers supplier, catalog, and platform routes.
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

// Routes returns every admin route this package owns.
func Routes() []Route {
	return append(append(SupplierRoutes(), CatalogRoutes()...), PlatformRoutes()...)
}

type handler struct{ Deps }

type wireError struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeErr(w http.ResponseWriter, status int, message, code string) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(wireError{Error: message, Code: code}); err != nil {
		slog.Error("json encode", "err", err)
		http.Error(w, msgUnavailable, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if _, err := w.Write(bytes.TrimRight(buf.Bytes(), "\n")); err != nil {
		slog.Error("json write", "err", err)
	}
}

func writeAdminJSON(w http.ResponseWriter, status int, body any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(body); err != nil {
		slog.Error("json encode", "err", err)
		writeErr(w, http.StatusInternalServerError, msgUnavailable, "INTERNAL")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if _, err := w.Write(bytes.TrimRight(buf.Bytes(), "\n")); err != nil {
		slog.Error("json write", "err", err)
	}
}

func writeFault(w http.ResponseWriter, fault *contract.Fault) {
	if fault == nil {
		writeErr(w, http.StatusInternalServerError, msgUnavailable, "INTERNAL")
		return
	}
	if fault.RetryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(fault.RetryAfter))
	}
	writeErr(w, fault.Status, fault.Message, fault.Code)
}

func (h handler) serve(w http.ResponseWriter, r *http.Request, rt Route) {
	if h.Ported != nil {
		if fn := h.Ported[rt.Method+" "+rt.Path]; fn != nil {
			fn(w, r)
			return
		}
	}
	if implemented(rt.Method, rt.Path) {
		h.serveUsers(w, r, rt)
		return
	}
	if x2Route(rt) && h.x2Wired(rt) {
		h.serveX2(w, r, rt)
		return
	}
	if h.AdminB != nil && adminBRoute(rt) {
		h.serveAdminB(w, r, rt)
		return
	}
	h.serveSupplier(w, r, rt)
}

func (h handler) serveUsers(w http.ResponseWriter, r *http.Request, rt Route) {
	fam := errorFamily(rt.Method, rt.Path)
	p, ok := principalUsers(w, r, h.Resolve, fam)
	if !ok {
		return
	}
	switch rt.Guard {
	case GuardWorkspace:
		if p.OrgID == 0 {
			writeErr(w, http.StatusForbidden, msgNoWorkspace, "FORBIDDEN")
			return
		}
	case GuardLogin:
	case GuardStaff:
		if !domain.PlatformStaff(p.PlatformRole) {
			writeErr(w, http.StatusForbidden, contract.ErrStaffDenied.Error(), "FORBIDDEN")
			return
		}
	case GuardSuper, GuardInferred, GuardPrice:
		if !domain.SuperAdmin(p.PlatformRole) {
			writeErr(w, http.StatusForbidden, msgSuperAdmin, "FORBIDDEN")
			return
		}
	default:
		writeErr(w, http.StatusNotImplemented, contract.ErrNotPorted.Error(), "not_ported")
		return
	}
	if h.API == nil {
		writeErr(w, http.StatusNotImplemented, contract.ErrNotPorted.Error(), "not_ported")
		return
	}
	actor := domain.Actor{
		ID: p.UserID, OrgID: p.OrgID, Email: p.Email, PublicID: p.PublicID,
		Role: p.PlatformRole, TokenHash: p.TokenHash,
	}
	if wantsStepUp(rt.Method, rt.Path) {
		if fault := h.API.RequireStepUp(r.Context(), actor); fault != nil {
			writeAuthFault(w, fam, fault)
			return
		}
	}
	h.dispatchPlatform(w, r, rt, actor)
}

func (h handler) serveSupplier(w http.ResponseWriter, r *http.Request, rt Route) {
	if strings.HasPrefix(rt.Path, "/api/admin/platform-catalog") &&
		domain.CrossOriginWrite(r.Method, r.Header.Get("Cookie"), r.Header.Get("Sec-Fetch-Site"), r.Header.Get("Origin"), r.Host) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		writeCloud(w, http.StatusForbidden, "csrf_rejected", "跨站请求已被拒绝")
		return
	}
	fam := familyOf(rt.Path)
	var early []byte
	if rt.Method == http.MethodPatch && rt.Path == "/api/admin/supplier-accounts/{member_id}" {
		body, err := readBody(r)
		if err != nil {
			writeFamily(w, fam, http.StatusBadRequest, "请求格式无效", "")
			return
		}
		if domain.PatchEmpty(body) {
			writeFamily(w, fam, http.StatusBadRequest, "没有要修改的内容", contract.KindValidation)
			return
		}
		early = body
		if domain.PatchWantsSuper(body) {
			rt.Guard = GuardSuper
		} else {
			rt.Guard = GuardStaff
		}
	}
	if rt.Method == http.MethodPost && (rt.Path == "/api/admin/supplier-withdrawals/{withdrawal_id}/pay" || rt.Path == "/api/admin/supplier-withdrawals/{withdrawal_id}/reject") {
		body, err := readBody(r)
		if err != nil {
			writeFamily(w, fam, http.StatusBadRequest, "请求格式无效", contract.KindValidation)
			return
		}
		var shape error
		if strings.HasSuffix(rt.Path, "/pay") {
			_, shape = domain.DecodePay(body)
		} else {
			_, shape = domain.DecodeReject(body)
		}
		if shape != nil {
			writeFail(w, fam, shape)
			return
		}
		early = body
	}
	p, ok := principal(w, r, h.Resolve, fam)
	if !ok {
		return
	}
	if h.platformA2(w, r, rt, p) {
		return
	}
	if !allow(w, fam, p, rt) {
		return
	}
	if privateCatalog(rt.Path) {
		w = &privateWriter{ResponseWriter: w}
	}
	if h.dispatch(w, r, rt, p, early) {
		return
	}
	writeErr(w, http.StatusNotImplemented, contract.ErrNotPorted.Error(), "not_ported")
}

func allow(w http.ResponseWriter, fam string, p Session, rt Route) bool {
	switch rt.Guard {
	case GuardWorkspace:
		if p.OrgID == 0 {
			writeErr(w, http.StatusForbidden, msgNoWorkspace, "FORBIDDEN")
			return false
		}
	case GuardLogin:
	case GuardStaff:
		if !domain.PlatformStaff(p.PlatformRole) {
			if fam == "legacy" {
				writeErr(w, http.StatusForbidden, contract.ErrStaffDenied.Error(), "FORBIDDEN")
			} else {
				writeFamily(w, fam, http.StatusForbidden, "需要平台管理员权限", "")
			}
			return false
		}
	case GuardSuper, GuardInferred, GuardPrice:
		if !domain.SuperAdmin(p.PlatformRole) {
			if fam == "legacy" {
				writeErr(w, http.StatusForbidden, msgSuperAdmin, "FORBIDDEN")
			} else {
				writeFamily(w, fam, http.StatusForbidden, msgSuperAdmin, "")
			}
			return false
		}
	default:
		writeErr(w, http.StatusNotImplemented, contract.ErrNotPorted.Error(), "not_ported")
		return false
	}
	return true
}

func principal(w http.ResponseWriter, r *http.Request, resolve Resolve, fam string) (Session, bool) {
	if resolve == nil {
		writeAuth(w, fam, http.StatusUnauthorized, msgUnauthenticated)
		return Session{}, false
	}
	p, refusal, err := resolve(r)
	if err != nil {
		writeFamily(w, fam, http.StatusInternalServerError, msgUnavailable, "")
		return Session{}, false
	}
	if refusal != nil {
		writeAuth(w, fam, refusal.Status, refusal.Message)
		return Session{}, false
	}
	if p == nil {
		writeAuth(w, fam, http.StatusUnauthorized, msgUnauthenticated)
		return Session{}, false
	}
	return *p, true
}

func principalUsers(w http.ResponseWriter, r *http.Request, resolve Resolve, fam family) (Session, bool) {
	if resolve == nil {
		writeAuthStatus(w, fam, http.StatusUnauthorized, msgUnauthenticated)
		return Session{}, false
	}
	p, refusal, err := resolve(r)
	if err != nil {
		writeAuthStatus(w, fam, http.StatusInternalServerError, msgUnavailable)
		return Session{}, false
	}
	if refusal != nil {
		writeAuthStatus(w, fam, refusal.Status, refusal.Message)
		return Session{}, false
	}
	if p == nil {
		writeAuthStatus(w, fam, http.StatusUnauthorized, msgUnauthenticated)
		return Session{}, false
	}
	return *p, true
}
