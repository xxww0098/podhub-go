// Package storehttp serves company groups and store renames.
package storehttp

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
	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

const (
	// PathStore is the display-name update. A changed name sets name_source manual.
	PathStore = "/api/workspaces/stores/{uuid}"
	// PathRefresh reads /v1/seller/info again through the existing seller egress.
	PathRefresh = "/api/workspaces/stores/{uuid}/seller-info"
)

// Session is the caller the assembly layer already resolved.
type Session struct {
	UserID        int64
	OrgID         int64
	WorkspaceRole string
}

// Refusal is an authentication answer.
type Refusal struct {
	Status  int
	Message string
}

// Resolve answers one request. A non-nil Refusal wins. A nil session and a
// nil refusal means logged out.
type Resolve func(*http.Request) (*Session, *Refusal, error)

// Actions is the store company service.
type Actions interface {
	Rename(ctx context.Context, orgID, userID int64, role, storeUUID, name string) (domain.Store, error)
	Refresh(ctx context.Context, orgID, userID int64, role, storeUUID string) (domain.Store, string, error)
}

// Deps is the mount input.
type Deps struct {
	Resolve Resolve
	Actions Actions
	// Tags serves the three Workspace Store tag routes. Nil leaves them on
	// the 501 path.
	Tags TagActions
	// Roster serves the roster read and its writes, the group routes, and the
	// tombstone acknowledgement. Nil leaves them on the 501 path.
	Roster RosterActions
	// Credential serves key custody. Nil leaves its routes unmounted.
	Credential CredentialActions
	// Refresh serves the two snapshot refresh loops.
	Refresh RefreshActions
	// Products serves the products mirror pages.
	Products ProductActions
}

// Mount registers the group read and the rename write.
func Mount(r chi.Router, d Deps) {
	if r == nil {
		return
	}
	h := handler{Deps: d}
	r.Method(http.MethodPost, PathRefresh, http.HandlerFunc(h.refresh))
	if d.Tags != nil {
		r.Method(http.MethodPost, PathTags, http.HandlerFunc(h.createTag))
		r.Method(http.MethodPut, PathTag, http.HandlerFunc(h.renameTag))
		r.Method(http.MethodDelete, PathTag, http.HandlerFunc(h.deleteTag))
	}
	// PathStore's PUT is one field of the roster patch, so it needs the roster
	// half. Without it the route is not mounted at all.
	if d.Roster != nil {
		r.Method(http.MethodPut, PathStore, http.HandlerFunc(h.updateStore))
		r.Method(http.MethodGet, PathRoster, http.HandlerFunc(h.listStores))
		r.Method(http.MethodPost, PathRoster, http.HandlerFunc(h.createStore))
		r.Method(http.MethodDelete, PathStore, http.HandlerFunc(h.deleteStore))
		r.Method(http.MethodPost, PathRosterAssignee, http.HandlerFunc(h.setAssignee))
		r.Method(http.MethodPost, PathRosterGroups, http.HandlerFunc(h.createGroup))
		r.Method(http.MethodPut, PathRosterGroup, http.HandlerFunc(h.renameGroup))
		r.Method(http.MethodDelete, PathRosterGroup, http.HandlerFunc(h.deleteGroup))
		r.Method(http.MethodPost, PathTombstone, http.HandlerFunc(h.consumeTombstone))
	}
	if d.Credential != nil {
		r.Method(http.MethodPost, PathCredential, http.HandlerFunc(h.registerCredential))
		r.Method(http.MethodDelete, PathCredential, http.HandlerFunc(h.deleteCredential))
		r.Method(http.MethodPost, PathCredentialTest, http.HandlerFunc(h.testCredential))
		r.Method(http.MethodPost, PathCredentialExport, http.HandlerFunc(h.exportCredentials))
	}
	if d.Refresh != nil {
		r.Method(http.MethodPost, PathProductQuotaRefresh, http.HandlerFunc(h.refreshProductQuotas))
		r.Method(http.MethodPost, PathFinanceBalanceRefresh, http.HandlerFunc(h.refreshFinanceBalances))
	}
	if d.Products != nil {
		r.Method(http.MethodGet, PathProducts, http.HandlerFunc(h.listProducts))
		r.Method(http.MethodGet, PathProductsOverview, http.HandlerFunc(h.productsOverview))
		r.Method(http.MethodPost, PathProductSync, http.HandlerFunc(h.syncProducts))
		r.Method(http.MethodPost, PathProductVerify, http.HandlerFunc(h.verifyProducts))
		r.Method(http.MethodGet, PathThumbnail, http.HandlerFunc(h.thumbnail))
	}
}

type handler struct{ Deps }

type wireError struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

type storeBody struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	ShortName string     `json:"company_short_name"`
	LegalName string     `json:"company_legal_name"`
	Source    string     `json:"name_source"`
	Order     int64      `json:"create_order"`
	Currency  string     `json:"company_currency"`
	Country   string     `json:"company_country"`
	Premium   *bool      `json:"subscription_is_premium"`
	SubType   string     `json:"subscription_type"`
	SyncedAt  *time.Time `json:"seller_info_synced_at"`
	KeyStatus string     `json:"seller_key_status"`
	KeyReason string     `json:"seller_key_reason"`
}

type refreshBody struct {
	storeBody
	CurrencyMismatch bool   `json:"currency_mismatch"`
	CurrencyWarning  string `json:"currency_warning"`
}

type groupBody struct {
	Name   string      `json:"name"`
	Count  int         `json:"count"`
	Stores []storeBody `json:"stores"`
}

func (h handler) refresh(w http.ResponseWriter, r *http.Request) {
	p, ok := principal(w, r, h.Resolve)
	if !ok {
		return
	}
	if status, msg, bad := workspace(p); bad {
		writeErr(w, status, msg, "FORBIDDEN")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8192))
	if err != nil || !emptyObject(raw) {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
		return
	}
	if h.Actions == nil {
		writeErr(w, http.StatusServiceUnavailable, access.MsgUnavailable, "INTERNAL")
		return
	}
	store, warning, err := h.Actions.Refresh(r.Context(), p.OrgID, p.UserID, p.WorkspaceRole, chi.URLParam(r, "uuid"))
	if err != nil {
		writeFail(w, err)
		return
	}
	body := refreshBody{storeBody: storeJSON(store), CurrencyWarning: warning, CurrencyMismatch: warning != ""}
	writeJSON(w, http.StatusOK, body)
}

func emptyObject(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return true
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	var obj struct{}
	if err := dec.Decode(&obj); err != nil {
		return false
	}
	return !dec.More()
}

func storeJSON(store domain.Store) storeBody {
	status := store.KeyStatus
	if status == "" {
		status = domain.KeyUnknown
	}
	return storeBody{
		ID: store.UUID, Name: store.Name, ShortName: store.ShortName,
		LegalName: store.LegalName, Source: store.Source, Order: store.CreateOrder,
		Currency: store.Currency, Country: store.Country, Premium: store.Premium,
		SubType: store.SubType, SyncedAt: store.SyncedAt, KeyStatus: status, KeyReason: store.KeyReason,
	}
}

func workspace(p Session) (int, string, bool) {
	if p.OrgID <= 0 || strings.TrimSpace(p.WorkspaceRole) == "" {
		return http.StatusForbidden, access.MsgNoWorkspace, true
	}
	if _, ok := access.ParseWorkspace(p.WorkspaceRole); !ok {
		return http.StatusForbidden, access.MsgBadWorkspaceRole, true
	}
	return 0, "", false
}

func principal(w http.ResponseWriter, r *http.Request, resolve Resolve) (Session, bool) {
	if resolve == nil {
		writeErr(w, http.StatusUnauthorized, access.MsgUnauthenticated, "AUTH_REQUIRED")
		return Session{}, false
	}
	p, refusal, err := resolve(r)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, access.MsgUnavailable, "INTERNAL")
		return Session{}, false
	}
	if refusal != nil {
		code := "AUTH_REQUIRED"
		if refusal.Status == http.StatusForbidden {
			code = "FORBIDDEN"
		}
		status := refusal.Status
		if status == 0 {
			status = http.StatusUnauthorized
		}
		writeErr(w, status, refusal.Message, code)
		return Session{}, false
	}
	if p == nil {
		writeErr(w, http.StatusUnauthorized, access.MsgUnauthenticated, "AUTH_REQUIRED")
		return Session{}, false
	}
	return *p, true
}

func writeFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, contract.ErrNotFound):
		writeErr(w, http.StatusNotFound, "店铺不存在", "NOT_FOUND")
	case errors.Is(err, contract.ErrForbidden):
		writeErr(w, http.StatusForbidden, access.MsgManager, "FORBIDDEN")
	case errors.Is(err, contract.ErrNoCredential):
		writeErr(w, http.StatusConflict, "店铺尚未登记密钥", "CONFLICT")
	case errors.Is(err, contract.ErrName):
		writeErr(w, http.StatusBadRequest, "店铺名不能为空", "VALIDATION")
	case errors.Is(err, contract.ErrNameLength):
		writeErr(w, http.StatusBadRequest, "店铺名过长", "VALIDATION")
	case errors.Is(err, contract.ErrNoTenant), errors.Is(err, contract.ErrUnavailable):
		writeErr(w, http.StatusServiceUnavailable, access.MsgUnavailable, "INTERNAL")
	default:
		slog.Error("store company", "err", err.Error())
		writeErr(w, http.StatusServiceUnavailable, access.MsgUnavailable, "INTERNAL")
	}
}

func writeErr(w http.ResponseWriter, status int, message, code string) {
	writeJSON(w, status, wireError{Error: message, Code: code})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(body); err != nil {
		slog.Error("store company json", "err", err.Error())
		http.Error(w, access.MsgUnavailable, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(bytes.TrimRight(buf.Bytes(), "\n"))
}

func jsonContent(ct string) bool {
	media, _, _ := strings.Cut(ct, ";")
	return strings.EqualFold(strings.TrimSpace(media), "application/json")
}
