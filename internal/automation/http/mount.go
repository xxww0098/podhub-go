// Package automationhttp mounts the automation runtime routes.
package automationhttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/automation/contract"
	"github.com/xxww0098/podhub-go/internal/automation/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

const (
	msgUnauthenticated = access.MsgUnauthenticated
	msgNoWorkspace     = access.MsgNoWorkspace
	msgBadRole         = access.MsgBadWorkspaceRole
	msgUnavailable     = contract.MsgUnavailable
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

// Deps is the session resolver and the use-case service.
// Actions is nil only when the process has no database pool.
type Deps struct {
	Resolve Resolve
	Actions *service.Service
}

// Mount registers the routes.
func Mount(r chi.Router, d Deps) {
	if r == nil {
		return
	}
	h := handler{Deps: d}
	for _, rt := range Routes() {
		rt := rt
		r.Method(rt.Method, rt.Path, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			h.serve(w, req)
		}))
	}
}

type handler struct{ Deps }

type wireError struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeErr(w http.ResponseWriter, status int, message, code string, retry int) {
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
	if retry > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(retry))
	}
	w.WriteHeader(status)
	if _, err := w.Write(bytes.TrimRight(buf.Bytes(), "\n")); err != nil {
		slog.Error("json write", "err", err)
	}
}

func writeFault(w http.ResponseWriter, err error) {
	var fault *contract.Fault
	if !errors.As(err, &fault) || fault == nil {
		fault = contract.Unavailable()
	}
	status := http.StatusInternalServerError
	code := "INTERNAL"
	switch fault.Kind {
	case "validation":
		status, code = http.StatusBadRequest, "VALIDATION"
	case "not_found":
		status, code = http.StatusNotFound, "NOT_FOUND"
	case "forbidden":
		status, code = http.StatusForbidden, "FORBIDDEN"
	case "busy":
		status = http.StatusServiceUnavailable
	case "conflict":
		status = http.StatusConflict
	}
	writeErr(w, status, fault.Message, code, fault.Retry)
}

func writeOK(w http.ResponseWriter, data any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(struct {
		Data any `json:"data"`
	}{Data: data}); err != nil {
		slog.Error("json encode", "err", err)
		writeFault(w, contract.Unavailable())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(bytes.TrimRight(buf.Bytes(), "\n")); err != nil {
		slog.Error("json write", "err", err)
	}
}

func (h handler) serve(w http.ResponseWriter, r *http.Request) {
	p, ok := principal(w, r, h.Resolve)
	if !ok {
		return
	}
	if p.OrgID <= 0 || strings.TrimSpace(p.WorkspaceRole) == "" {
		writeErr(w, http.StatusForbidden, msgNoWorkspace, "FORBIDDEN", 0)
		return
	}
	if _, parsed := access.ParseWorkspace(p.WorkspaceRole); !parsed {
		writeErr(w, http.StatusForbidden, msgBadRole, "FORBIDDEN", 0)
		return
	}
	if h.Actions == nil {
		writeFault(w, contract.Unavailable())
		return
	}
	switch r.Method + " " + chi.RouteContext(r.Context()).RoutePattern() {
	case "GET /api/automation/asset-sets":
		h.listAssets(w, r, p)
	case "POST /api/automation/asset-sets":
		h.createAsset(w, r, p)
	case "POST /api/automation/commands/claim":
		h.claim(w, r, p)
	case "POST /api/automation/commands/renew":
		h.renew(w, r, p)
	case "POST /api/automation/commands/{id}/progress":
		h.progress(w, r, p)
	case "POST /api/automation/commands/{id}/settle":
		h.settle(w, r, p)
	case "GET /api/automation/grants":
		h.listGrants(w, r, p)
	case "POST /api/automation/grants":
		h.createGrant(w, r, p)
	case "POST /api/automation/grants/{id}/revoke":
		h.revokeGrant(w, r, p)
	case "GET /api/automation/runtimes":
		h.listRuntimes(w, r, p)
	case "POST /api/automation/runtimes":
		h.registerRuntime(w, r, p)
	case "POST /api/automation/runtimes/{id}/deregister":
		h.deregister(w, r, p)
	case "POST /api/automation/runtimes/{id}/heartbeat":
		h.heartbeat(w, r, p)
	default:
		writeFault(w, contract.Unavailable())
	}
}

func principal(w http.ResponseWriter, r *http.Request, resolve Resolve) (Session, bool) {
	if resolve == nil {
		writeErr(w, http.StatusUnauthorized, msgUnauthenticated, "AUTH_INVALID", 0)
		return Session{}, false
	}
	p, refusal, err := resolve(r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgUnavailable, "INTERNAL", 0)
		return Session{}, false
	}
	if refusal != nil {
		code := "AUTH_INVALID"
		if refusal.Status == http.StatusForbidden {
			code = "FORBIDDEN"
		}
		writeErr(w, refusal.Status, refusal.Message, code, 0)
		return Session{}, false
	}
	if p == nil {
		writeErr(w, http.StatusUnauthorized, msgUnauthenticated, "AUTH_INVALID", 0)
		return Session{}, false
	}
	return *p, true
}
