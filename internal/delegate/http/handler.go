// Package delegatehttp is the seller delegate HTTP surface.
package delegatehttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/delegate/domain"
	"github.com/xxww0098/podhub-go/internal/delegate/service"
)

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
// This package does not import internal/access.
type Session interface {
	Resolve(r *http.Request) (*Principal, *Refusal, error)
}

// Actions is the supplier dispatch surface. The sixteen seller routes do not
// call it. POST /api/seller/upstream stays 501 and does not call Proxy.
type Actions interface {
	Accept(ctx context.Context, orgID, userID int64, dispatchID string) (string, error)
	Reject(ctx context.Context, orgID, userID int64, dispatchID, reason string) (string, error)
	Ship(ctx context.Context, orgID, userID int64, dispatchID, trackingNo, note string, nowMS int64) (string, error)
	ListDispatches(ctx context.Context, orgID, supplierUserID int64) ([]contract.DispatchView, error)
	Presign(ctx context.Context) error
	Proxy(ctx context.Context) error
}

// SellerAPI is the sixteen seller routes. *service.Seller implements it.
type SellerAPI interface {
	Sources(ctx context.Context, actor service.Actor) ([]contract.Source, error)
	Bindings(ctx context.Context, actor service.Actor, storeID string) ([]contract.Binding, error)
	CreateBinding(ctx context.Context, actor service.Actor, storeID, offerID, sourceID, note string) (contract.Binding, error)
	PatchBinding(ctx context.Context, actor service.Actor, bindingID string, expected int64, sourceID, note *string, active *bool) (contract.Binding, error)
	DeleteBinding(ctx context.Context, actor service.Actor, bindingID string) error
	Presign(ctx context.Context, actor service.Actor, bindingID, sha, mime, fileName string, bytes int64, checksum bool) (contract.UploadTarget, error)
	Finalize(ctx context.Context, actor service.Actor, bindingID, ticket, fileName string, position int32) (contract.Asset, error)
	DeleteAsset(ctx context.Context, actor service.Actor, assetID string) (string, bool, error)
	Orders(ctx context.Context, actor service.Actor, storeID, state, cursor string, limit *int64) ([]contract.Order, bool, string, error)
	Order(ctx context.Context, actor service.Actor, orderID string) (contract.Order, error)
	CreateOrder(ctx context.Context, actor service.Actor, storeID, postingNumber, sellerNote, idempotency string, offerIDs []string, offerIDsSet bool) (contract.Order, error)
	Postings(ctx context.Context, actor service.Actor, storeID string, windowDays, limit int64, cursor string) (string, []contract.PostingView, bool, string, error)
	PostingStates(ctx context.Context, actor service.Actor, storeID, numbers string) (string, []contract.PostingStateView, error)
	Cancel(ctx context.Context, actor service.Actor, orderID string) (contract.Order, error)
	Close(ctx context.Context, actor service.Actor, orderID string) (contract.Order, error)
	Nudge(ctx context.Context, actor service.Actor, orderID string) (contract.Order, error)
}

// Deps is the mount input. Outbound is never used by these routes.
type Deps struct {
	Session  Session
	Actions  Actions
	Seller   SellerAPI
	Outbound http.RoundTripper
}

type route struct {
	method    string
	path      string
	workspace bool
}

// routes is the seller delegate list. The upstream proxy is mounted by the
// seller package on the wildcard path, including GET.
var routes = []route{
	{http.MethodPost, "/api/seller/delegate/assets", true},
	{http.MethodPost, "/api/seller/delegate/assets/presign", true},
	{http.MethodDelete, "/api/seller/delegate/assets/{asset_id}", true},
	{http.MethodGet, "/api/seller/delegate/bindings", true},
	{http.MethodPost, "/api/seller/delegate/bindings", true},
	{http.MethodDelete, "/api/seller/delegate/bindings/{binding_id}", true},
	{http.MethodPatch, "/api/seller/delegate/bindings/{binding_id}", true},
	{http.MethodGet, "/api/seller/delegate/orders", true},
	{http.MethodPost, "/api/seller/delegate/orders", true},
	{http.MethodGet, "/api/seller/delegate/orders/{order_id}", true},
	{http.MethodPost, "/api/seller/delegate/orders/{order_id}/cancel", true},
	{http.MethodPost, "/api/seller/delegate/orders/{order_id}/close", true},
	{http.MethodPost, "/api/seller/delegate/orders/{order_id}/nudge", true},
	{http.MethodGet, "/api/seller/delegate/posting-states", true},
	{http.MethodPost, "/api/seller/delegate/postings", true},
	{http.MethodGet, "/api/seller/delegate/sources", true},
}

// Mount registers the routes. Method and path stay the golden table.
func Mount(r chi.Router, d Deps) {
	for _, rt := range routes {
		rt := rt
		r.Method(rt.method, rt.path, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			d.handle(w, req, rt)
		}))
	}
}

func (d Deps) handle(w http.ResponseWriter, r *http.Request, rt route) {
	p, ok := principal(w, r, d.Session)
	if !ok {
		return
	}
	if !rt.workspace {
		_ = d.Outbound
		_ = d.Actions
		notPorted(w)
		return
	}
	actor, ok := requireTenant(w, p)
	if !ok {
		return
	}
	if d.Seller == nil {
		writeAPI(w, contract.Internal(), false)
		return
	}
	switch rt.method + " " + rt.path {
	case http.MethodGet + " /api/seller/delegate/sources":
		d.sources(w, r, actor)
	case http.MethodGet + " /api/seller/delegate/bindings":
		d.bindings(w, r, actor)
	case http.MethodPost + " /api/seller/delegate/bindings":
		d.createBinding(w, r, actor)
	case http.MethodPatch + " /api/seller/delegate/bindings/{binding_id}":
		d.patchBinding(w, r, actor)
	case http.MethodDelete + " /api/seller/delegate/bindings/{binding_id}":
		d.deleteBinding(w, r, actor)
	case http.MethodPost + " /api/seller/delegate/assets/presign":
		d.presign(w, r, actor)
	case http.MethodPost + " /api/seller/delegate/assets":
		d.finalize(w, r, actor)
	case http.MethodDelete + " /api/seller/delegate/assets/{asset_id}":
		d.deleteAsset(w, r, actor)
	case http.MethodGet + " /api/seller/delegate/orders":
		d.orders(w, r, actor)
	case http.MethodGet + " /api/seller/delegate/orders/{order_id}":
		d.order(w, r, actor)
	case http.MethodPost + " /api/seller/delegate/orders":
		d.createOrder(w, r, actor)
	case http.MethodPost + " /api/seller/delegate/orders/{order_id}/cancel":
		d.cancel(w, r, actor)
	case http.MethodPost + " /api/seller/delegate/orders/{order_id}/close":
		d.close(w, r, actor)
	case http.MethodPost + " /api/seller/delegate/orders/{order_id}/nudge":
		d.nudge(w, r, actor)
	case http.MethodPost + " /api/seller/delegate/postings":
		d.postings(w, r, actor)
	case http.MethodGet + " /api/seller/delegate/posting-states":
		d.postingStates(w, r, actor)
	default:
		notPorted(w)
	}
}

func requireTenant(w http.ResponseWriter, p Principal) (service.Actor, bool) {
	if p.OrgID == 0 || strings.TrimSpace(p.WorkspaceRole) == "" {
		writeAPI(w, contract.Forbidden(contract.MsgNoWorkspace), false)
		return service.Actor{}, false
	}
	manage, err := domain.CanManage(p.WorkspaceRole)
	if err != nil {
		writeAPI(w, err, false)
		return service.Actor{}, false
	}
	return service.Actor{UserID: p.UserID, OrgID: p.OrgID, Role: p.WorkspaceRole, CanManage: manage}, true
}

func (d Deps) sources(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	rows, err := d.Seller.Sources(r.Context(), actor)
	if err != nil {
		writeAPI(w, err, false)
		return
	}
	if rows == nil {
		rows = []contract.Source{}
	}
	writeJSON(w, http.StatusOK, struct {
		Data struct {
			Sources []contract.Source `json:"sources"`
		} `json:"data"`
	}{Data: struct {
		Sources []contract.Source `json:"sources"`
	}{Sources: rows}})
}

func (d Deps) bindings(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	q := r.URL.Query()
	if !q.Has("storeId") {
		writeQuery(w, "storeId")
		return
	}
	rows, err := d.Seller.Bindings(r.Context(), actor, q.Get("storeId"))
	if err != nil {
		writeAPI(w, err, false)
		return
	}
	if rows == nil {
		rows = []contract.Binding{}
	}
	for i := range rows {
		if rows[i].Assets == nil {
			rows[i].Assets = []contract.Asset{}
		}
	}
	writeJSON(w, http.StatusOK, struct {
		Data struct {
			Bindings []contract.Binding `json:"bindings"`
		} `json:"data"`
	}{Data: struct {
		Bindings []contract.Binding `json:"bindings"`
	}{Bindings: rows}})
}

func (d Deps) createBinding(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	raw, ok := readJSON(w, r, businessBodyLimit, false)
	if !ok {
		return
	}
	var body struct {
		StoreID  *json.RawMessage `json:"storeId"`
		OfferID  *json.RawMessage `json:"offerId"`
		SourceID *json.RawMessage `json:"sourceId"`
		Note     *json.RawMessage `json:"note"`
	}
	if !decodeStrict(raw, &body) {
		invalidJSON(w, false)
		return
	}
	storeID, okStore := reqString(body.StoreID)
	offerID, okOffer := reqString(body.OfferID)
	sourceID, okSource := reqString(body.SourceID)
	note, okNote := defString(body.Note)
	if !okStore || !okOffer || !okSource || !okNote {
		invalidJSON(w, false)
		return
	}
	row, err := d.Seller.CreateBinding(r.Context(), actor, storeID, offerID, sourceID, note)
	if err != nil {
		writeAPI(w, err, false)
		return
	}
	if row.Assets == nil {
		row.Assets = []contract.Asset{}
	}
	writeJSON(w, http.StatusOK, dataBinding(row))
}

func (d Deps) patchBinding(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	raw, ok := readJSON(w, r, businessBodyLimit, false)
	if !ok {
		return
	}
	var body struct {
		SourceID *json.RawMessage `json:"sourceId"`
		Note     *json.RawMessage `json:"note"`
		Active   *json.RawMessage `json:"active"`
		Expected *json.RawMessage `json:"expectedRevision"`
	}
	if !decodeStrict(raw, &body) {
		invalidJSON(w, false)
		return
	}
	sourceID, okSource := optString(body.SourceID)
	note, okNote := optString(body.Note)
	active, okActive := optBool(body.Active)
	expected, okExpected := reqInt64(body.Expected)
	if !okSource || !okNote || !okActive || !okExpected {
		invalidJSON(w, false)
		return
	}
	row, err := d.Seller.PatchBinding(r.Context(), actor, chi.URLParam(r, "binding_id"), expected, sourceID, note, active)
	if err != nil {
		writeAPI(w, err, false)
		return
	}
	if row.Assets == nil {
		row.Assets = []contract.Asset{}
	}
	writeJSON(w, http.StatusOK, dataBinding(row))
}

func (d Deps) deleteBinding(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	id := chi.URLParam(r, "binding_id")
	if err := d.Seller.DeleteBinding(r.Context(), actor, id); err != nil {
		writeAPI(w, err, false)
		return
	}
	normalized, _ := domain.NormalizeUUID(id)
	writeJSON(w, http.StatusOK, struct {
		Data struct {
			BindingID string `json:"bindingId"`
			Deleted   bool   `json:"deleted"`
		} `json:"data"`
	}{Data: struct {
		BindingID string `json:"bindingId"`
		Deleted   bool   `json:"deleted"`
	}{BindingID: normalized, Deleted: true}})
}

func (d Deps) presign(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	raw, ok := readJSON(w, r, businessBodyLimit, true)
	if !ok {
		return
	}
	var body struct {
		BindingID *json.RawMessage `json:"bindingId"`
		SHA       *json.RawMessage `json:"sha256"`
		Bytes     *json.RawMessage `json:"bytes"`
		Mime      *json.RawMessage `json:"mime"`
		FileName  *json.RawMessage `json:"fileName"`
	}
	if !decodeStrict(raw, &body) {
		invalidJSON(w, true)
		return
	}
	bindingID, okBinding := reqString(body.BindingID)
	sha, okSHA := reqString(body.SHA)
	size, okSize := reqInt64(body.Bytes)
	mime, okMime := reqString(body.Mime)
	fileName, okName := reqString(body.FileName)
	if !okBinding || !okSHA || !okSize || !okMime || !okName {
		invalidJSON(w, true)
		return
	}
	target, err := d.Seller.Presign(r.Context(), actor, bindingID, sha, mime, fileName, size, checksumRequested(r, sha))
	if err != nil {
		writeAPI(w, err, true)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, http.StatusOK, struct {
		Data struct {
			Upload contract.UploadTarget `json:"upload"`
		} `json:"data"`
	}{Data: struct {
		Upload contract.UploadTarget `json:"upload"`
	}{Upload: target}})
}

func (d Deps) finalize(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	raw, ok := readJSON(w, r, assetBodyLimit, true)
	if !ok {
		return
	}
	var body struct {
		BindingID *json.RawMessage `json:"bindingId"`
		Ticket    *json.RawMessage `json:"uploadTicket"`
		FileName  *json.RawMessage `json:"fileName"`
		Position  *json.RawMessage `json:"position"`
	}
	if !decodeStrict(raw, &body) {
		invalidJSON(w, true)
		return
	}
	bindingID, okBinding := reqString(body.BindingID)
	ticket, okTicket := reqString(body.Ticket)
	fileName, okName := reqString(body.FileName)
	position, okPos := defInt64(body.Position, 0)
	if !okBinding || !okTicket || !okName || !okPos || position < -2147483648 || position > 2147483647 {
		invalidJSON(w, true)
		return
	}
	ctx := service.WithSessionRecheck(r.Context(), func() (int64, int64, error) {
		if d.Session == nil {
			return 0, 0, contract.Internal()
		}
		p, refusal, err := d.Session.Resolve(r)
		if err != nil {
			return 0, 0, contract.Internal()
		}
		if refusal != nil {
			return 0, 0, contract.Unauthenticated(refusal.Message)
		}
		if p == nil || p.UserID <= 0 {
			return 0, 0, contract.Forbidden("上传期间登录或工作空间已变化")
		}
		return p.UserID, p.OrgID, nil
	})
	asset, err := d.Seller.Finalize(ctx, actor, bindingID, ticket, fileName, int32(position))
	if err != nil {
		writeAPI(w, err, true)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Data struct {
			Asset contract.Asset `json:"asset"`
		} `json:"data"`
	}{Data: struct {
		Asset contract.Asset `json:"asset"`
	}{Asset: asset}})
}

func (d Deps) deleteAsset(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	id, reclaimed, err := d.Seller.DeleteAsset(r.Context(), actor, chi.URLParam(r, "asset_id"))
	if err != nil {
		writeAPI(w, err, false)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Data struct {
			AssetID   string `json:"assetId"`
			Reclaimed bool   `json:"reclaimed"`
		} `json:"data"`
	}{Data: struct {
		AssetID   string `json:"assetId"`
		Reclaimed bool   `json:"reclaimed"`
	}{AssetID: id, Reclaimed: reclaimed}})
}

func (d Deps) orders(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	q := r.URL.Query()
	var limit *int64
	if q.Has("limit") {
		n, ok := parseQueryInt(q.Get("limit"))
		if !ok {
			writeQueryType(w)
			return
		}
		limit = &n
	}
	rows, hasNext, cursor, err := d.Seller.Orders(r.Context(), actor, q.Get("storeId"), q.Get("state"), q.Get("cursor"), limit)
	if err != nil {
		writeAPI(w, err, false)
		return
	}
	if rows == nil {
		rows = []contract.Order{}
	}
	for i := range rows {
		if rows[i].Lines == nil {
			rows[i].Lines = []contract.OrderLine{}
		}
	}
	writeJSON(w, http.StatusOK, struct {
		Data struct {
			Orders  []contract.Order `json:"orders"`
			HasNext bool             `json:"hasNext"`
			Cursor  string           `json:"cursor"`
		} `json:"data"`
	}{Data: struct {
		Orders  []contract.Order `json:"orders"`
		HasNext bool             `json:"hasNext"`
		Cursor  string           `json:"cursor"`
	}{Orders: rows, HasNext: hasNext, Cursor: cursor}})
}

func (d Deps) order(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	row, err := d.Seller.Order(r.Context(), actor, chi.URLParam(r, "order_id"))
	if err != nil {
		writeAPI(w, err, false)
		return
	}
	if row.Lines == nil {
		row.Lines = []contract.OrderLine{}
	}
	writeJSON(w, http.StatusOK, dataOrder(row))
}

func (d Deps) createOrder(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	raw, ok := readJSON(w, r, businessBodyLimit, false)
	if !ok {
		return
	}
	var body struct {
		StoreID    *json.RawMessage `json:"storeId"`
		Posting    *json.RawMessage `json:"postingNumber"`
		OfferIDs   *json.RawMessage `json:"offerIds"`
		SellerNote *json.RawMessage `json:"sellerNote"`
	}
	if !decodeStrict(raw, &body) {
		invalidJSON(w, false)
		return
	}
	storeID, okStore := reqString(body.StoreID)
	posting, okPosting := reqString(body.Posting)
	note, okNote := defString(body.SellerNote)
	offers, offersSet, okOffers := optOffers(body.OfferIDs)
	if !okStore || !okPosting || !okNote || !okOffers {
		invalidJSON(w, false)
		return
	}
	key, err := domain.IdempotencyKey(r.Header.Get("Idempotency-Key"), headerUTF8(r, "Idempotency-Key"))
	if err != nil {
		writeAPI(w, err, false)
		return
	}
	row, err := d.Seller.CreateOrder(r.Context(), actor, storeID, posting, note, key, offers, offersSet)
	if err != nil {
		writeAPI(w, err, false)
		return
	}
	if row.Lines == nil {
		row.Lines = []contract.OrderLine{}
	}
	writeJSON(w, http.StatusOK, dataOrder(row))
}

func (d Deps) cancel(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	row, err := d.Seller.Cancel(r.Context(), actor, chi.URLParam(r, "order_id"))
	writeOrder(w, row, err)
}

func (d Deps) close(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	row, err := d.Seller.Close(r.Context(), actor, chi.URLParam(r, "order_id"))
	writeOrder(w, row, err)
}

func (d Deps) nudge(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	row, err := d.Seller.Nudge(r.Context(), actor, chi.URLParam(r, "order_id"))
	writeOrder(w, row, err)
}

func writeOrder(w http.ResponseWriter, row contract.Order, err error) {
	if err != nil {
		writeAPI(w, err, false)
		return
	}
	if row.Lines == nil {
		row.Lines = []contract.OrderLine{}
	}
	writeJSON(w, http.StatusOK, dataOrder(row))
}

func (d Deps) postings(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	raw, ok := readJSON(w, r, businessBodyLimit, false)
	if !ok {
		return
	}
	var body struct {
		StoreID *json.RawMessage `json:"storeId"`
		Window  *json.RawMessage `json:"windowDays"`
		Cursor  *json.RawMessage `json:"cursor"`
		Limit   *json.RawMessage `json:"limit"`
	}
	if !decodeStrict(raw, &body) {
		invalidJSON(w, false)
		return
	}
	storeID, okStore := reqString(body.StoreID)
	window, okWindow := defInt64(body.Window, 30)
	limit, okLimit := defInt64(body.Limit, 50)
	cursor, okCursor := optCursor(body.Cursor)
	if !okStore || !okWindow || !okLimit || !okCursor {
		invalidJSON(w, false)
		return
	}
	store, rows, hasNext, next, err := d.Seller.Postings(r.Context(), actor, storeID, window, limit, cursor)
	if err != nil {
		writeAPI(w, err, false)
		return
	}
	if rows == nil {
		rows = []contract.PostingView{}
	}
	writeJSON(w, http.StatusOK, struct {
		Data struct {
			StoreID  string                 `json:"storeId"`
			Postings []contract.PostingView `json:"postings"`
			HasNext  bool                   `json:"hasNext"`
			Cursor   string                 `json:"cursor"`
		} `json:"data"`
	}{Data: struct {
		StoreID  string                 `json:"storeId"`
		Postings []contract.PostingView `json:"postings"`
		HasNext  bool                   `json:"hasNext"`
		Cursor   string                 `json:"cursor"`
	}{StoreID: store, Postings: rows, HasNext: hasNext, Cursor: next}})
}

func (d Deps) postingStates(w http.ResponseWriter, r *http.Request, actor service.Actor) {
	q := r.URL.Query()
	if !q.Has("storeId") {
		writeQuery(w, "storeId")
		return
	}
	if !q.Has("postingNumbers") {
		writeQuery(w, "postingNumbers")
		return
	}
	store, rows, err := d.Seller.PostingStates(r.Context(), actor, q.Get("storeId"), q.Get("postingNumbers"))
	if err != nil {
		writeAPI(w, err, false)
		return
	}
	if rows == nil {
		rows = []contract.PostingStateView{}
	}
	writeJSON(w, http.StatusOK, struct {
		Data struct {
			StoreID string                      `json:"storeId"`
			States  []contract.PostingStateView `json:"states"`
		} `json:"data"`
	}{Data: struct {
		StoreID string                      `json:"storeId"`
		States  []contract.PostingStateView `json:"states"`
	}{StoreID: store, States: rows}})
}

func dataBinding(row contract.Binding) any {
	return struct {
		Data struct {
			Binding contract.Binding `json:"binding"`
		} `json:"data"`
	}{Data: struct {
		Binding contract.Binding `json:"binding"`
	}{Binding: row}}
}

func dataOrder(row contract.Order) any {
	return struct {
		Data struct {
			Order contract.Order `json:"order"`
		} `json:"data"`
	}{Data: struct {
		Order contract.Order `json:"order"`
	}{Order: row}}
}

func principal(w http.ResponseWriter, r *http.Request, session Session) (Principal, bool) {
	if session == nil {
		writeAPI(w, contract.Unauthenticated(""), false)
		return Principal{}, false
	}
	p, refusal, err := session.Resolve(r)
	if err != nil {
		slog.Error("delegate access", "err", err)
		writeAPI(w, contract.Internal(), false)
		return Principal{}, false
	}
	if refusal != nil {
		switch refusal.Status {
		case http.StatusUnauthorized:
			writeAPI(w, &contract.APIError{Status: http.StatusUnauthorized, Code: "auth_invalid", Message: refusal.Message}, false)
		case http.StatusForbidden:
			writeAPI(w, contract.Forbidden(refusal.Message), false)
		default:
			writeAPI(w, contract.Internal(), false)
		}
		return Principal{}, false
	}
	if p == nil || p.UserID <= 0 {
		writeAPI(w, contract.Unauthenticated(""), false)
		return Principal{}, false
	}
	return *p, true
}

type apiError struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeAPI(w http.ResponseWriter, err error, asset bool) {
	var api *contract.APIError
	if !errors.As(err, &api) || api == nil {
		api = contract.Internal()
	}
	if asset {
		w.Header().Set("Cache-Control", "private, no-store")
	}
	for key, value := range api.Headers {
		w.Header().Set(key, value)
	}
	writeErr(w, api.Status, api.Message, api.Code)
}

func writeErr(w http.ResponseWriter, status int, message, code string) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(apiError{Error: message, Code: code}); err != nil {
		slog.Error("json encode", "err", err)
		http.Error(w, contract.MsgUnavailable, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if _, err := w.Write(bytes.TrimRight(buf.Bytes(), "\n")); err != nil {
		slog.Error("json write", "err", err)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(body); err != nil {
		writeErr(w, http.StatusInternalServerError, contract.MsgUnavailable, "internal")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if _, err := w.Write(bytes.TrimRight(buf.Bytes(), "\n")); err != nil {
		slog.Error("json write", "err", err)
	}
}

func notPorted(w http.ResponseWriter) {
	writeErr(w, http.StatusNotImplemented, "not_ported", "not_ported")
}
