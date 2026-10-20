// Package warehousehttp is the tenant warehouse and delivery-method surface.
package warehousehttp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/warehouse/contract"
	"github.com/xxww0098/podhub-go/internal/warehouse/domain"
	"github.com/xxww0098/podhub-go/internal/warehouse/service"
)

// Principal is the account the session already resolved.
type Principal struct {
	UserID        int64
	OrgID         int64
	WorkspaceRole string
}

// Refusal is an authentication answer.
type Refusal struct {
	Status  int
	Message string
	Code    string
}

// Session resolves the caller. The org id comes from here, not the body.
type Session interface {
	Resolve(r *http.Request) (*Principal, *Refusal, error)
}

// Actions is the warehouse service.
type Actions interface {
	List(ctx context.Context, actor service.Actor) ([]contract.Warehouse, contract.SyncStamp, error)
	Get(ctx context.Context, actor service.Actor, warehouseID int64) (contract.Warehouse, error)
	Sync(ctx context.Context, actor service.Actor) (contract.Snapshot, error)
	Grant(ctx context.Context, in service.GrantInput) (service.GrantResult, error)
	Report(ctx context.Context, in contract.ReportWrite) (contract.ReportDone, error)
	OperationStatus(ctx context.Context, actor service.Actor, operationID string) (service.OpStatus, error)
}

// Deps is the mount input. WritesDisabled is the bool captured at process start.
type Deps struct {
	Session        Session
	Actions        Actions
	Read           func(role string) bool
	Write          func(role string) bool
	WritesDisabled bool
	Now            func() time.Time
}

// Mount registers the warehouse routes. Drop-off lists stay 501.
func Mount(r chi.Router, d Deps) {
	if r == nil {
		return
	}
	h := handler{deps: d}
	r.Get("/api/seller/warehouses", h.list)
	r.Get("/api/seller/warehouses/{warehouse_id}", h.get)
	r.Post("/api/seller/warehouses/sync", h.sync)
	r.Post("/api/seller/warehouses/grant", h.grant)
	r.Post("/api/seller/warehouses/report", h.report)
	r.Post("/api/seller/warehouses/operations/status", h.operation)
	r.Post("/api/seller/warehouses/drop-off/list", h.notPorted)
}

type handler struct{ deps Deps }

func (h handler) list(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.actor(w, r, false)
	if !ok {
		return
	}
	actor.StoreID = r.URL.Query().Get("storeId")
	rows, stamp, err := h.deps.Actions.List(r.Context(), actor)
	if writeAPI(w, err) {
		return
	}
	body := struct {
		Warehouses []warehouseJSON `json:"warehouses"`
		SyncedAt   *string         `json:"syncedAt"`
	}{Warehouses: housesJSON(rows)}
	if stamp.HasWh {
		s := stamp.Warehouses.UTC().Format(time.RFC3339Nano)
		body.SyncedAt = &s
	}
	writeData(w, http.StatusOK, body)
}

func (h handler) get(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.actor(w, r, false)
	if !ok {
		return
	}
	actor.StoreID = r.URL.Query().Get("storeId")
	id, err := service.ParseID(chi.URLParam(r, "warehouse_id"))
	if writeAPI(w, err) {
		return
	}
	row, err := h.deps.Actions.Get(r.Context(), actor, id)
	if writeAPI(w, err) {
		return
	}
	writeData(w, http.StatusOK, houseJSON(row))
}

func (h handler) sync(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.actor(w, r, false)
	if !ok {
		return
	}
	var body struct {
		StoreID string `json:"storeId"`
	}
	if !h.readJSON(w, r, &body) {
		return
	}
	actor.StoreID = body.StoreID
	snap, err := h.deps.Actions.Sync(r.Context(), actor)
	if writeAPI(w, err) {
		return
	}
	writeData(w, http.StatusOK, struct {
		Warehouses int    `json:"warehouses"`
		Methods    int    `json:"methods"`
		SyncedAt   string `json:"syncedAt"`
	}{len(snap.Warehouses), len(snap.Methods), snap.At.UTC().Format(time.RFC3339Nano)})
}

func (h handler) grant(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	actor, ok := h.actor(w, r, true)
	if !ok {
		return
	}
	var body struct {
		StoreID           string `json:"storeId"`
		ClientOperationID string `json:"clientOperationId"`
		Kind              string `json:"kind"`
		WarehouseID       *int64 `json:"warehouseId"`
		Confirm           bool   `json:"confirm"`
		RequestHash       string `json:"requestHash"`
	}
	if !h.readJSON(w, r, &body) {
		return
	}
	result, err := h.deps.Actions.Grant(r.Context(), service.GrantInput{
		GrantWrite: contract.GrantWrite{
			OrgID: actor.OrgID, UserID: actor.UserID, StoreID: body.StoreID,
			ClientOperationID: body.ClientOperationID, Kind: body.Kind,
			WarehouseID: body.WarehouseID, Confirm: body.Confirm, RequestHash: body.RequestHash,
		},
		Role:           actor.Role,
		WritesDisabled: h.deps.WritesDisabled,
	})
	if writeAPI(w, err) {
		return
	}
	writeData(w, http.StatusOK, struct {
		IntentID    string `json:"intentId"`
		State       string `json:"state"`
		ClientID    string `json:"clientId"`
		APIKey      string `json:"apiKey"`
		ExpiresAtMS int64  `json:"expiresAtMs"`
		TTLMS       int64  `json:"ttlMs"`
	}{result.IntentID, result.State, result.ClientID, result.APIKey, result.ExpiresAtMS, result.TTLMS})
}

func (h handler) report(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	actor, ok := h.actor(w, r, true)
	if !ok {
		return
	}
	var body struct {
		IntentID    string `json:"intentId"`
		HTTPStatus  *int   `json:"httpStatus"`
		OperationID string `json:"operationId"`
	}
	if !h.readJSON(w, r, &body) {
		return
	}
	done, err := h.deps.Actions.Report(r.Context(), contract.ReportWrite{
		OrgID: actor.OrgID, UserID: actor.UserID, IntentID: body.IntentID,
		HTTPStatus: body.HTTPStatus, OperationID: body.OperationID,
	})
	if writeAPI(w, err) {
		return
	}
	writeData(w, http.StatusOK, struct {
		IntentID    string `json:"intentId"`
		State       string `json:"state"`
		OperationID string `json:"operationId"`
	}{done.IntentID, done.State, done.OperationID})
}

func (h handler) operation(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.actor(w, r, false)
	if !ok {
		return
	}
	var body struct {
		StoreID     string `json:"storeId"`
		OperationID string `json:"operationId"`
	}
	if !h.readJSON(w, r, &body) {
		return
	}
	actor.StoreID = body.StoreID
	got, err := h.deps.Actions.OperationStatus(r.Context(), actor, body.OperationID)
	if writeAPI(w, err) {
		return
	}
	writeData(w, http.StatusOK, struct {
		OperationID string `json:"operationId"`
		Status      string `json:"status"`
		WarehouseID *int64 `json:"warehouseId,omitempty"`
	}{got.OperationID, got.Status, got.WarehouseID})
}

func (h handler) notPorted(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.actor(w, r, false); !ok {
		return
	}
	writeAPI(w, contract.NotPorted())
}

func (h handler) actor(w http.ResponseWriter, r *http.Request, write bool) (service.Actor, bool) {
	if h.deps.Session == nil || h.deps.Actions == nil {
		writeAPI(w, contract.Unavailable())
		return service.Actor{}, false
	}
	p, refusal, err := h.deps.Session.Resolve(r)
	if err != nil {
		writeAPI(w, contract.Unavailable())
		return service.Actor{}, false
	}
	if refusal != nil {
		code := refusal.Code
		if code == "" {
			code = "forbidden"
		}
		status := refusal.Status
		if status == 0 {
			status = http.StatusForbidden
		}
		writeJSON(w, status, errBody{Error: refusal.Message, Code: code})
		return service.Actor{}, false
	}
	if p == nil || p.UserID == 0 {
		writeJSON(w, http.StatusUnauthorized, errBody{Error: access.MsgUnauthenticated, Code: "AUTH_REQUIRED"})
		return service.Actor{}, false
	}
	if p.OrgID <= 0 || p.WorkspaceRole == "" {
		writeJSON(w, http.StatusForbidden, errBody{Error: access.MsgNoWorkspace, Code: "forbidden"})
		return service.Actor{}, false
	}
	allow := h.deps.Read
	if write {
		allow = h.deps.Write
	}
	if allow == nil || !allow(p.WorkspaceRole) {
		writeJSON(w, http.StatusForbidden, errBody{Error: access.MsgListingForbidden, Code: "forbidden"})
		return service.Actor{}, false
	}
	return service.Actor{OrgID: p.OrgID, UserID: p.UserID, Role: p.WorkspaceRole}, true
}

func (h handler) readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil || json.Unmarshal(raw, dst) != nil {
		writeAPI(w, contract.BadRequest("请求无效"))
		return false
	}
	return true
}

type errBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeAPI(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	var fail *contract.Fail
	if errors.As(err, &fail) {
		writeJSON(w, fail.Status, errBody{Error: fail.Message, Code: fail.Code})
		return true
	}
	writeJSON(w, http.StatusInternalServerError, errBody{Error: "服务暂不可用", Code: "internal"})
	return true
}

func writeData(w http.ResponseWriter, status int, data any) {
	writeJSON(w, status, struct {
		Data any `json:"data"`
	}{Data: data})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	raw, err := json.Marshal(body)
	if err != nil {
		status = http.StatusInternalServerError
		raw = []byte(`{"error":"服务暂不可用","code":"internal"}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

type warehouseJSON struct {
	WarehouseID int64  `json:"warehouseId"`
	Name        string `json:"name"`
	Status      string `json:"status"`
	IsRFBS      bool   `json:"isRfbs"`
	IsActive    bool   `json:"isActive"`
	Archived    bool   `json:"archived"`
	SyncedAt    string `json:"syncedAt"`
}

func housesJSON(rows []contract.Warehouse) []warehouseJSON {
	out := make([]warehouseJSON, 0, len(rows))
	for _, row := range rows {
		out = append(out, houseJSON(row))
	}
	return out
}

func houseJSON(row contract.Warehouse) warehouseJSON {
	return warehouseJSON{
		WarehouseID: row.WarehouseID, Name: row.Name, Status: row.Status, IsRFBS: row.IsRFBS,
		IsActive: domain.IsActive(row.Status, row.Archived), Archived: row.Archived,
		SyncedAt: row.SyncedAt.UTC().Format(time.RFC3339Nano),
	}
}
