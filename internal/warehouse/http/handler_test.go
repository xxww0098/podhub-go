package warehousehttp

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/identity"
	"github.com/xxww0098/podhub-go/internal/warehouse/contract"
	"github.com/xxww0098/podhub-go/internal/warehouse/service"
)

func TestMemberCannotWriteAndDropOffStaysUnported(t *testing.T) {
	r := chi.NewRouter()
	Mount(r, Deps{Session: roleSession{"member"}, Actions: fakeActions{}, Read: allowRead, Write: allowWrite})
	rec := post(r, "/api/seller/warehouses/grant", `{"storeId":"x","clientOperationId":"op","kind":"create"}`)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"forbidden"`) {
		t.Fatal(rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "apiKey") {
		t.Fatal(rec.Body.String())
	}
	rec = post(r, "/api/seller/warehouses/drop-off/list", `{}`)
	if rec.Code != http.StatusNotImplemented || !strings.Contains(rec.Body.String(), `"not_ported"`) {
		t.Fatal(rec.Code, rec.Body.String())
	}
	viewer := chi.NewRouter()
	Mount(viewer, Deps{Session: roleSession{"viewer"}, Actions: fakeActions{}, Read: allowRead, Write: allowWrite})
	rec = post(viewer, "/api/seller/warehouses/report", `{"intentId":"00000000-0000-0000-0000-000000000001"}`)
	if rec.Code != http.StatusForbidden {
		t.Fatal(rec.Code, rec.Body.String())
	}
}

func TestKillSwitchResponseHasNoKey(t *testing.T) {
	const key = "fixture-warehouse-api-key"
	r := chi.NewRouter()
	Mount(r, Deps{
		Session:        roleSession{"owner"},
		Actions:        fakeActions{key: key},
		Read:           allowRead,
		Write:          allowWrite,
		WritesDisabled: true,
	})
	rec := post(r, "/api/seller/warehouses/grant", `{"storeId":"11111111-1111-1111-1111-111111111111","clientOperationId":"op","kind":"create"}`)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "OZON_WRITES_DISABLED") {
		t.Fatal(rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), key) || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(rec.Header().Get("Cache-Control"), rec.Body.String())
	}
}

func TestOpenAPIListsWarehouseRoutes(t *testing.T) {
	raw, err := os.ReadFile("../../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, path := range []string{
		`"/api/seller/warehouses":`,
		`"/api/seller/warehouses/{warehouse_id}":`,
		`"/api/seller/warehouses/sync":`,
		`"/api/seller/warehouses/grant":`,
		`"/api/seller/warehouses/report":`,
		`"/api/seller/warehouses/operations/status":`,
		`"/api/seller/warehouses/drop-off/list":`,
	} {
		if !strings.Contains(text, path) {
			t.Fatal(path)
		}
	}
	if strings.Contains(text, "operationId: syncSellerWarehouses") {
		t.Fatal("collection POST")
	}
}

func allowRead(role string) bool {
	parsed, ok := identity.ParseWorkspaceRole(role)
	return ok && parsed.Allows(identity.CapStoreRead)
}

func allowWrite(role string) bool {
	parsed, ok := identity.ParseWorkspaceRole(role)
	return ok && parsed.Allows(identity.CapWarehouseWrite)
}

func post(h http.Handler, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

type roleSession struct{ role string }

func (s roleSession) Resolve(*http.Request) (*Principal, *Refusal, error) {
	return &Principal{UserID: 7, OrgID: 3, WorkspaceRole: s.role}, nil, nil
}

type fakeActions struct{ key string }

func (fakeActions) List(context.Context, service.Actor) ([]contract.Warehouse, contract.SyncStamp, error) {
	return nil, contract.SyncStamp{}, nil
}
func (fakeActions) Get(context.Context, service.Actor, int64) (contract.Warehouse, error) {
	return contract.Warehouse{}, contract.NotFound()
}
func (fakeActions) Sync(context.Context, service.Actor) (contract.Snapshot, error) {
	return contract.Snapshot{}, nil
}
func (fakeActions) Methods(context.Context, service.Actor, int64) ([]contract.Method, error) {
	return nil, nil
}
func (fakeActions) Method(context.Context, service.Actor, int64) (contract.Method, error) {
	return contract.Method{}, contract.NotFound()
}
func (fakeActions) SyncMethods(context.Context, service.Actor) ([]contract.Method, error) {
	return nil, nil
}
func (f fakeActions) Grant(_ context.Context, in service.GrantInput) (service.GrantResult, error) {
	if in.WritesDisabled {
		return service.GrantResult{}, contract.WritesDisabled()
	}
	return service.GrantResult{APIKey: f.key, State: "granted"}, nil
}
func (fakeActions) Report(context.Context, contract.ReportWrite) (contract.ReportDone, error) {
	return contract.ReportDone{}, nil
}
func (fakeActions) OperationStatus(context.Context, service.Actor, string) (service.OpStatus, error) {
	return service.OpStatus{}, nil
}
