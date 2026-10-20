// Package supplyhttp is the seller and public platform-catalog surface.
package supplyhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/supply/contract"
	"github.com/xxww0098/podhub-go/internal/supply/domain"
)

const msgUnavailable = "服务暂不可用"

// Principal is the account the session already resolved.
type Principal struct {
	UserID        int64
	OrgID         int64
	WorkspaceRole string
}

// Refusal is an authentication answer. Status is the HTTP status.
type Refusal struct {
	Status  int
	Message string
}

// Session is the identity seam. internal/app adapts the process resolver.
type Session interface {
	Resolve(r *http.Request) (*Principal, *Refusal, error)
}

// Actions is the supply service the handlers call after auth and validation.
type Actions interface {
	PublicCatalog(ctx context.Context) (contract.PublicCatalogData, error)
	SellerCatalog(ctx context.Context, orgID int64) (contract.SellerCatalogData, error)
	SellerProduct(ctx context.Context, orgID int64, productID string) (contract.SellerProduct, error)
}

// Deps is the mount input. Outbound is unused: these routes do not dial.
type Deps struct {
	Session  Session
	Actions  Actions
	Outbound http.RoundTripper
	Now      func() time.Time
}

type route struct {
	method string
	path   string
}

// routes is the supply-chain list. Method and path stay stable.
var routes = []route{
	{http.MethodGet, "/api/platform-catalog"},
	{http.MethodGet, "/api/platform-catalog/products/{product_id}"},
	{http.MethodGet, "/api/public/platform-catalog"},
}

// Mount registers the three routes.
func Mount(r chi.Router, d Deps) {
	r.Get("/api/public/platform-catalog", d.publicCatalog)
	r.Get("/api/platform-catalog", d.sellerCatalog)
	r.Get("/api/platform-catalog/products/{product_id}", d.product)
}

func (d Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d Deps) publicCatalog(w http.ResponseWriter, r *http.Request) {
	_ = d.Outbound
	data, err := d.Actions.PublicCatalog(r.Context())
	if err != nil {
		writeFailure(w, err)
		return
	}
	if data.Products == nil {
		data.Products = []contract.PublicProduct{}
	}
	w.Header().Set("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
	writeData(w, http.StatusOK, data)
}

func (d Deps) sellerCatalog(w http.ResponseWriter, r *http.Request) {
	p, ok := d.tenant(w, r)
	if !ok {
		return
	}
	data, err := d.Actions.SellerCatalog(r.Context(), p.OrgID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if data.Products == nil {
		data.Products = []contract.SellerProduct{}
	}
	writeData(w, http.StatusOK, data)
}

func (d Deps) product(w http.ResponseWriter, r *http.Request) {
	p, ok := d.tenant(w, r)
	if !ok {
		return
	}
	data, err := d.Actions.SellerProduct(r.Context(), p.OrgID, chi.URLParam(r, "product_id"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeData(w, http.StatusOK, struct {
		Product contract.SellerProduct `json:"product"`
	}{data})
}

func (d Deps) tenant(w http.ResponseWriter, r *http.Request) (Principal, bool) {
	_ = d.Outbound
	if d.Session == nil {
		writeErr(w, http.StatusUnauthorized, access.MsgUnauthenticated, "AUTH_INVALID")
		return Principal{}, false
	}
	p, refusal, err := d.Session.Resolve(r)
	if err != nil {
		slog.Error("supply access", "err", err)
		writeErr(w, http.StatusInternalServerError, msgUnavailable, "INTERNAL")
		return Principal{}, false
	}
	if refusal != nil {
		switch refusal.Status {
		case http.StatusUnauthorized:
			writeErr(w, http.StatusUnauthorized, refusal.Message, "AUTH_INVALID")
		case http.StatusForbidden:
			writeErr(w, http.StatusForbidden, refusal.Message, "FORBIDDEN")
		default:
			writeErr(w, http.StatusInternalServerError, msgUnavailable, "INTERNAL")
		}
		return Principal{}, false
	}
	if p == nil || p.UserID <= 0 {
		writeErr(w, http.StatusUnauthorized, access.MsgUnauthenticated, "AUTH_INVALID")
		return Principal{}, false
	}
	if p.OrgID <= 0 || strings.TrimSpace(p.WorkspaceRole) == "" {
		writeErr(w, http.StatusForbidden, access.MsgNoWorkspace, "FORBIDDEN")
		return Principal{}, false
	}
	if _, ok := access.ParseWorkspace(p.WorkspaceRole); !ok {
		writeErr(w, http.StatusForbidden, access.MsgBadWorkspaceRole, "FORBIDDEN")
		return Principal{}, false
	}
	return *p, true
}

type filesField struct {
	files []domain.ProductionFile
}

func (f *filesField) UnmarshalJSON(raw []byte) error {
	if string(raw) == "null" {
		return errors.New("null")
	}
	var rows []struct {
		MediaAssetID string  `json:"mediaAssetId"`
		ContentHash  *string `json:"contentHash"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&rows); err != nil {
		return err
	}
	f.files = make([]domain.ProductionFile, 0, len(rows))
	for _, row := range rows {
		item := domain.ProductionFile{MediaAssetID: row.MediaAssetID}
		if row.ContentHash != nil {
			item.ContentHash = *row.ContentHash
			item.HasHash = true
		}
		f.files = append(f.files, item)
	}
	return nil
}

type optInt struct {
	set bool
	n   int64
}

func (o *optInt) UnmarshalJSON(raw []byte) error {
	if string(raw) == "null" {
		return errors.New("null")
	}
	if err := json.Unmarshal(raw, &o.n); err != nil {
		return err
	}
	o.set = true
	return nil
}

func strictJSON(r *http.Request, dest any) error {
	ct := r.Header.Get("Content-Type")
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(ct)), "application/json") {
		return errors.New("type")
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 2*1024*1024+1))
	if err != nil {
		return err
	}
	if len(body) > 2*1024*1024 {
		return errors.New("limit")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dest); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing")
	}
	return nil
}

type envelope struct {
	Data any `json:"data"`
}

func writeData(w http.ResponseWriter, status int, data any) {
	writeJSON(w, status, envelope{Data: data}, false)
}

type apiError struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeFailure(w http.ResponseWriter, err error) {
	if f, ok := contract.AsFailure(err); ok {
		if f.RetryAfter != "" {
			w.Header().Set("Retry-After", f.RetryAfter)
		}
		writeErr(w, f.Status, f.Message, f.Code)
		return
	}
	if errors.Is(err, contract.ErrNotPorted) {
		writeErr(w, http.StatusNotImplemented, "not_ported", "not_ported")
		return
	}
	slog.Error("supply", "err", err)
	writeErr(w, http.StatusInternalServerError, msgUnavailable, "INTERNAL")
}

func writeErr(w http.ResponseWriter, status int, message, code string) {
	writeJSON(w, status, apiError{Error: message, Code: code}, true)
}

func writeJSON(w http.ResponseWriter, status int, v any, nosniff bool) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		slog.Error("json encode", "err", err)
		http.Error(w, msgUnavailable, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if nosniff {
		w.Header().Set("X-Content-Type-Options", "nosniff")
	}
	w.WriteHeader(status)
	_, _ = w.Write(bytes.TrimRight(buf.Bytes(), "\n"))
}
