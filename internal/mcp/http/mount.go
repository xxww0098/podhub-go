// Package mcphttp serves /mcp.
// Authentication happens before the method check. DNS-rebinding checks run
// on POST after the grant resolves. There is no QuickJS runner in this process.
package mcphttp

import (
	"io"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/mcp/domain"
	"github.com/xxww0098/podhub-go/internal/mcp/service"
)

const unauthorizedBody = `{"error":"invalid or expired automation grant token"}`

// SessionResolve reads a user session. A nil caller and a nil error means
// the request is not a live session. The error is not written to the client.
type SessionResolve func(r *http.Request) (*domain.Caller, error)

// Deps is the parsed allow-list plus the protocol service.
// Session, when set, accepts the same user session the admin API accepts.
// An opa_ grant never uses Session.
type Deps struct {
	Allow      domain.Allow
	RunnerPath string
	Handler    *service.Service
	Session    SessionResolve
}

// Mount registers GET, POST, and DELETE /mcp.
func Mount(r chi.Router, d Deps) {
	if r == nil {
		return
	}
	if d.Handler == nil {
		d.Handler = service.New(nil)
	}
	h := handler{Deps: d}
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		r.Method(method, "/mcp", http.HandlerFunc(h.serve))
	}
}

type handler struct{ Deps }

func (h handler) serve(w http.ResponseWriter, r *http.Request) {
	token, err := domain.BearerToken(r.Header.Get("Authorization"))
	if err == nil {
		h.serveGrant(w, r, token)
		return
	}
	h.serveSession(w, r)
}

func (h handler) serveGrant(w http.ResponseWriter, r *http.Request, token string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		w.WriteHeader(http.StatusMethodNotAllowed)
		_, _ = w.Write([]byte("Method Not Allowed"))
		return
	}
	if !h.allow(w, r) {
		return
	}
	hash := domain.HashToken(token)
	grant, err := h.Handler.ResolveForGate(r.Context(), hash)
	if err != nil || grant == nil {
		if err != nil {
			slog.Error("automation token resolution failed")
		}
		writeUnauthorized(w)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2*1024*1024))
	if err != nil {
		return
	}
	status, payload := h.Handler.Handle(r.Context(), hash, body)
	writeJSON(w, status, payload)
}

func (h handler) serveSession(w http.ResponseWriter, r *http.Request) {
	if h.Session == nil {
		writeUnauthorized(w)
		return
	}
	caller, err := h.Session(r)
	if err != nil || caller == nil {
		if err != nil {
			slog.Error("mcp session resolution failed")
		}
		writeUnauthorized(w)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		w.WriteHeader(http.StatusMethodNotAllowed)
		_, _ = w.Write([]byte("Method Not Allowed"))
		return
	}
	if !h.allow(w, r) {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2*1024*1024))
	if err != nil {
		return
	}
	status, payload := h.Handler.HandleSession(r.Context(), *caller, body)
	writeJSON(w, status, payload)
}

func (h handler) allow(w http.ResponseWriter, r *http.Request) bool {
	if code, body := h.Allow.CheckHost(r.Host); code != 0 {
		writePlain(w, code, body)
		return false
	}
	if code, body := h.Allow.CheckOrigin(r.Header.Get("Origin")); code != 0 {
		writePlain(w, code, body)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("WWW-Authenticate", `Bearer realm="mcp"`)
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte(unauthorizedBody))
}

func writePlain(w http.ResponseWriter, status int, body string) {
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

// Runner is the configured runner path. It is not launched.
func (d Deps) Runner() string { return d.RunnerPath }
