// Package cataloghttp is the supplier catalogue manager surface.
//
// It is a separate mount from /api/admin/supplier-dbs on purpose: that surface
// runs through supply.WithTx, which sets app.staff_access unconditionally. A
// catalog manager must never acquire that marker, so this package talks to
// db.CatalogManager and nothing else.
package cataloghttp

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/suppliercatalog/contract"
)

// Principal is the account the session resolved.
type Principal struct {
	UserID int64
}

// Refusal is an authentication answer.
type Refusal struct {
	Status  int
	Message string
}

// Session is the identity seam. internal/app adapts the process resolver.
type Session interface {
	Resolve(r *http.Request) (*Principal, *Refusal, error)
}

// Actions is the catalogue service the handlers call.
type Actions interface {
	Sources(ctx context.Context, userID int64) (contract.SourceListData, error)
}

// Deps is the mount input.
type Deps struct {
	Session Session
	Actions Actions
	Now     func() time.Time
}

// Mount registers the routes.
func Mount(r chi.Router, d Deps) {
	r.Get("/api/supplier-catalog/sources", d.sources)
}

func (d Deps) sources(w http.ResponseWriter, r *http.Request) {
	p, ok := d.principal(w, r)
	if !ok {
		return
	}
	data, err := d.Actions.Sources(r.Context(), p.UserID)
	if err != nil {
		d.fail(w, err)
		return
	}
	if data.Sources == nil {
		data.Sources = []contract.SourceSummary{}
	}
	writeData(w, http.StatusOK, data)
}

func (d Deps) principal(w http.ResponseWriter, r *http.Request) (Principal, bool) {
	if d.Session == nil {
		writeErr(w, http.StatusUnauthorized, "未登录", "AUTH_INVALID")
		return Principal{}, false
	}
	p, refusal, err := d.Session.Resolve(r)
	if err != nil {
		slog.Error("supplier-catalog access", "err", err)
		writeErr(w, http.StatusInternalServerError, contract.MsgUnavailable, "INTERNAL")
		return Principal{}, false
	}
	if refusal != nil {
		writeErr(w, refusal.Status, refusal.Message, "FORBIDDEN")
		return Principal{}, false
	}
	if p == nil {
		writeErr(w, http.StatusUnauthorized, "未登录", "AUTH_INVALID")
		return Principal{}, false
	}
	return *p, true
}

func (d Deps) fail(w http.ResponseWriter, err error) {
	if err == nil {
		return
	}
	if f, ok := contract.AsFault(err); ok {
		if len(f.Missing) > 0 {
			writeJSON(w, f.Status, map[string]any{
				"error": f.Message, "code": f.Code, "missing": f.Missing,
			})
			return
		}
		writeErr(w, f.Status, f.Message, f.Code)
		return
	}
	slog.Error("supplier-catalog", "err", err)
	writeErr(w, http.StatusInternalServerError, contract.MsgUnavailable, "INTERNAL")
}

func writeData(w http.ResponseWriter, status int, data any) { writeJSON(w, status, data) }

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, message, code string) {
	writeJSON(w, status, map[string]string{"error": message, "code": code})
}

var _ = errors.Is
