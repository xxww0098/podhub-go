// Package supplierhttp is the supplier portal and supplier-db catalog surface.
package supplierhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
	"github.com/xxww0098/podhub-go/internal/supplier/domain"
)

const msgUnavailable = "服务暂不可用"

// Principal is the account the session already resolved.
type Principal struct {
	UserID int64
	OrgID  int64
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

// Actions is the supplier service the handlers call after auth and validation.
type Actions interface {
	Me(ctx context.Context, userID int64) (contract.MeData, error)
	ListDispatches(ctx context.Context, userID int64, state string, cursor domain.Cursor) (contract.DispatchListData, error)
	GetDispatch(ctx context.Context, userID int64, dispatchID string) (contract.DispatchDetail, error)
	Accept(ctx context.Context, userID int64, dispatchID string) (contract.ActionData, error)
	Reject(ctx context.Context, userID int64, dispatchID, reason string) (contract.ActionData, error)
	Wallets(ctx context.Context, userID int64) (contract.WalletListData, error)
	Withdrawals(ctx context.Context, userID int64) (contract.WithdrawalListData, error)
	CreateWithdrawal(ctx context.Context, userID int64, in domain.WithdrawalInput, nowMs int64) (contract.WithdrawalListData, error)
	DownloadAsset(ctx context.Context, userID int64, dispatchID, assetID string, wantJSON bool, nowMs int64) (contract.AssetBytes, error)
	Catalog(ctx context.Context, nowMs int64) (contract.CatalogData, error)
	CatalogImage(ctx context.Context, sourceID, file string, edge uint32) (contract.ImageBody, error)
}

// Deps is the mount input.
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

// routes is the supplier and supplier-db list. Method and path stay stable.
var routes = []route{
	{http.MethodGet, "/api/supplier-dbs/catalog"},
	{http.MethodGet, "/api/supplier-dbs/catalog/images/{source_id}/{file}"},
	{http.MethodGet, "/api/supplier/dispatches"},
	{http.MethodGet, "/api/supplier/dispatches/{dispatch_id}"},
	{http.MethodPost, "/api/supplier/dispatches/{dispatch_id}/accept"},
	{http.MethodGet, "/api/supplier/dispatches/{dispatch_id}/assets/{asset_id}"},
	{http.MethodPost, "/api/supplier/dispatches/{dispatch_id}/reject"},
	{http.MethodGet, "/api/supplier/me"},
	{http.MethodGet, "/api/supplier/wallet"},
	{http.MethodGet, "/api/supplier/withdrawals"},
	{http.MethodPost, "/api/supplier/withdrawals"},
}

// Mount registers the routes.
func Mount(r chi.Router, d Deps) {
	r.Get("/api/supplier/me", d.me)
	r.Get("/api/supplier/dispatches", d.dispatches)
	r.Get("/api/supplier/dispatches/{dispatch_id}", d.dispatch)
	r.Post("/api/supplier/dispatches/{dispatch_id}/accept", d.accept)
	r.Post("/api/supplier/dispatches/{dispatch_id}/reject", d.reject)
	r.Get("/api/supplier/dispatches/{dispatch_id}/assets/{asset_id}", d.asset)
	r.Get("/api/supplier/wallet", d.wallets)
	r.Get("/api/supplier/withdrawals", d.withdrawals)
	r.Post("/api/supplier/withdrawals", d.createWithdrawal)
	r.Get("/api/supplier-dbs/catalog", d.catalog)
	r.Get("/api/supplier-dbs/catalog/images/{source_id}/{file}", d.catalogImage)
}

func (d Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d Deps) me(w http.ResponseWriter, r *http.Request) {
	p, ok := supplierUser(w, r, d.Session)
	if !ok {
		return
	}
	data, err := d.Actions.Me(r.Context(), p.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeData(w, http.StatusOK, data)
}

func (d Deps) dispatches(w http.ResponseWriter, r *http.Request) {
	p, ok := supplierUser(w, r, d.Session)
	if !ok {
		return
	}
	state, err := domain.FilterState(r.URL.Query().Get("state"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	cursor, err := domain.DecodeCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	data, err := d.Actions.ListDispatches(r.Context(), p.UserID, state, cursor)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeData(w, http.StatusOK, data)
}

func (d Deps) dispatch(w http.ResponseWriter, r *http.Request) {
	p, ok := supplierUser(w, r, d.Session)
	if !ok {
		return
	}
	id, err := domain.ParseUUID(chi.URLParam(r, "dispatch_id"))
	if err != nil {
		writeFailure(w, contract.Fail(404, "not_found", "派发包不存在"))
		return
	}
	data, err := d.Actions.GetDispatch(r.Context(), p.UserID, id)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeData(w, http.StatusOK, struct {
		Dispatch contract.DispatchDetail `json:"dispatch"`
	}{data})
}

func (d Deps) accept(w http.ResponseWriter, r *http.Request) {
	p, ok := supplierUser(w, r, d.Session)
	if !ok {
		return
	}
	id, err := domain.ParseUUID(chi.URLParam(r, "dispatch_id"))
	if err != nil {
		writeFailure(w, contract.Fail(404, "not_found", "派发包不存在"))
		return
	}
	data, err := d.Actions.Accept(r.Context(), p.UserID, id)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeData(w, http.StatusOK, data)
}

func (d Deps) reject(w http.ResponseWriter, r *http.Request) {
	p, ok := supplierUser(w, r, d.Session)
	if !ok {
		return
	}
	var body struct {
		Reason *string `json:"reason"`
	}
	if err := strictJSON(r, &body); err != nil || body.Reason == nil {
		writeFailure(w, contract.Fail(400, "validation", "请求格式无效"))
		return
	}
	reason, err := domain.RejectReason(*body.Reason)
	if err != nil {
		writeFailure(w, err)
		return
	}
	id, err := domain.ParseUUID(chi.URLParam(r, "dispatch_id"))
	if err != nil {
		writeFailure(w, contract.Fail(404, "not_found", "派发包不存在"))
		return
	}
	data, err := d.Actions.Reject(r.Context(), p.UserID, id, reason)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeData(w, http.StatusOK, data)
}

func (d Deps) asset(w http.ResponseWriter, r *http.Request) {
	p, ok := supplierUser(w, r, d.Session)
	if !ok {
		return
	}
	dispatchID, err := domain.ParseUUID(chi.URLParam(r, "dispatch_id"))
	if err != nil {
		writeFailure(w, contract.Fail(404, "not_found", "派发包不存在"))
		return
	}
	assetID, err := domain.ParseUUID(chi.URLParam(r, "asset_id"))
	if err != nil {
		writeFailure(w, contract.Fail(404, "not_found", "素材不存在"))
		return
	}
	got, err := d.Actions.DownloadAsset(r.Context(), p.UserID, dispatchID, assetID, domain.WantsJSON(r.Header.Get("Accept")), d.now().UnixMilli())
	if err != nil {
		writeFailure(w, err)
		return
	}
	if got.Grant != nil {
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		writeData(w, http.StatusOK, got.Grant)
		return
	}
	w.Header().Set("Content-Type", got.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if got.FileName != "" {
		disp := "attachment"
		if got.Inline {
			disp = "inline"
		}
		w.Header().Set("Content-Disposition", disp+"; filename*=UTF-8''"+strings.ReplaceAll(got.FileName, " ", "%20"))
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(got.Body)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(got.Body)
}

func (d Deps) wallets(w http.ResponseWriter, r *http.Request) {
	p, ok := supplierUser(w, r, d.Session)
	if !ok {
		return
	}
	data, err := d.Actions.Wallets(r.Context(), p.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeData(w, http.StatusOK, data)
}

func (d Deps) withdrawals(w http.ResponseWriter, r *http.Request) {
	p, ok := supplierUser(w, r, d.Session)
	if !ok {
		return
	}
	data, err := d.Actions.Withdrawals(r.Context(), p.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeData(w, http.StatusOK, data)
}

func (d Deps) createWithdrawal(w http.ResponseWriter, r *http.Request) {
	p, ok := supplierUser(w, r, d.Session)
	if !ok {
		return
	}
	var body struct {
		SourceID *string `json:"sourceId"`
		Amount   *int64  `json:"amountCents"`
		Channel  *string `json:"channel"`
		Account  *string `json:"account"`
		RealName *string `json:"realName"`
	}
	if err := strictJSON(r, &body); err != nil || body.SourceID == nil || body.Amount == nil || body.Channel == nil || body.Account == nil || body.RealName == nil {
		writeFailure(w, contract.Fail(400, "validation", "请求格式无效"))
		return
	}
	in, err := domain.CheckWithdrawal(*body.SourceID, *body.Amount, *body.Channel, *body.Account, *body.RealName)
	if err != nil {
		writeFailure(w, err)
		return
	}
	data, err := d.Actions.CreateWithdrawal(r.Context(), p.UserID, in, d.now().UnixMilli())
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeData(w, http.StatusOK, data)
}

func (d Deps) catalog(w http.ResponseWriter, r *http.Request) {
	if _, ok := dbUser(w, r, d.Session); !ok {
		return
	}
	data, err := d.Actions.Catalog(r.Context(), d.now().UnixMilli())
	if err != nil {
		writeCatalog(w, err)
		return
	}
	if data.DBs == nil {
		data.DBs = []contract.SourceCard{}
	}
	if data.PropDefs == nil {
		data.PropDefs = []contract.PropDef{}
	}
	if data.Rows == nil {
		data.Rows = []contract.CatalogRow{}
	}
	writeData(w, http.StatusOK, data)
}

func (d Deps) catalogImage(w http.ResponseWriter, r *http.Request) {
	if _, ok := dbUser(w, r, d.Session); !ok {
		return
	}
	sourceID, err := domain.ParseSourceID(chi.URLParam(r, "source_id"))
	if err != nil {
		writeCatalog(w, err)
		return
	}
	file := chi.URLParam(r, "file")
	if _, _, err := domain.ParseImageFile(file); err != nil {
		writeCatalog(w, err)
		return
	}
	_, present := r.URL.Query()["edge"]
	edge, err := domain.ParseEdge(r.URL.Query().Get("edge"), present)
	if err != nil {
		writeCatalog(w, err)
		return
	}
	body, err := d.Actions.CatalogImage(r.Context(), sourceID, file, edge)
	if err != nil {
		writeCatalog(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("Content-Type", body.ContentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(body.Bytes)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body.Bytes)
}

func supplierUser(w http.ResponseWriter, r *http.Request, session Session) (Principal, bool) {
	p, ok := dbUser(w, r, session)
	if !ok {
		return Principal{}, false
	}
	return p, true
}

// dbUser is authenticated(). Supplier-db maps 401 through and folds every
// other auth status into 500. The portal then rewrites the code to snake_case
// only for /api/supplier, which supplierUser's callers do via writeFailure
// after this returns the principal. Auth failures are written here.
func dbUser(w http.ResponseWriter, r *http.Request, session Session) (Principal, bool) {
	portal := strings.HasPrefix(r.URL.Path, "/api/supplier/")
	code401, code500 := "AUTH_INVALID", "INTERNAL"
	if portal {
		code401, code500 = "auth_invalid", "internal"
	}
	if session == nil {
		writeErr(w, http.StatusUnauthorized, "未登录", code401)
		return Principal{}, false
	}
	p, refusal, err := session.Resolve(r)
	if err != nil {
		slog.Error("supplier access", "err", err)
		if portal {
			writeErr(w, http.StatusInternalServerError, msgUnavailable, code500)
		} else {
			writeErr(w, http.StatusInternalServerError, msgUnavailable, code500)
		}
		return Principal{}, false
	}
	if refusal != nil {
		if refusal.Status == http.StatusUnauthorized {
			writeErr(w, http.StatusUnauthorized, refusal.Message, code401)
			return Principal{}, false
		}
		if !portal && refusal.Status == http.StatusForbidden {
			writeErr(w, http.StatusForbidden, refusal.Message, "FORBIDDEN")
			return Principal{}, false
		}
		writeErr(w, http.StatusInternalServerError, msgUnavailable, code500)
		return Principal{}, false
	}
	if p == nil || p.UserID <= 0 {
		writeErr(w, http.StatusUnauthorized, "未登录", code401)
		return Principal{}, false
	}
	return *p, true
}

func strictJSON(r *http.Request, dest any) error {
	ct := r.Header.Get("Content-Type")
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(ct)), "application/json") {
		return errors.New("type")
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, 2*1024*1024+1))
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
	writeJSON(w, status, envelope{Data: data})
}

type apiError struct {
	Error   string   `json:"error"`
	Code    string   `json:"code"`
	Missing []string `json:"missing,omitempty"`
}

func writeFailure(w http.ResponseWriter, err error) {
	if err == nil {
		return
	}
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
	slog.Error("supplier", "err", err)
	code := "internal"
	writeErr(w, http.StatusInternalServerError, msgUnavailable, code)
}

// writeCatalog prints supplier-db codes in SCREAMING_SNAKE. Portal failures
// stay snake_case through writeFailure.
func writeCatalog(w http.ResponseWriter, err error) {
	if f, ok := contract.AsFailure(err); ok {
		if f.RetryAfter != "" {
			w.Header().Set("Retry-After", f.RetryAfter)
		}
		writeErr(w, f.Status, f.Message, screamCode(f.Code))
		return
	}
	slog.Error("supplier catalog", "err", err)
	writeErr(w, http.StatusInternalServerError, msgUnavailable, "INTERNAL")
}

func screamCode(code string) string {
	switch code {
	case "auth_invalid":
		return "AUTH_INVALID"
	case "forbidden":
		return "FORBIDDEN"
	case "validation":
		return "VALIDATION"
	case "not_found":
		return "NOT_FOUND"
	case "conflict":
		return "CONFLICT"
	case "internal":
		return "INTERNAL"
	case "writes_disabled":
		return "WRITES_DISABLED"
	default:
		return code
	}
}

func writeErr(w http.ResponseWriter, status int, message, code string) {
	writeJSON(w, status, apiError{Error: message, Code: code})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		slog.Error("json encode", "err", err)
		http.Error(w, msgUnavailable, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(bytes.TrimRight(buf.Bytes(), "\n"))
}
