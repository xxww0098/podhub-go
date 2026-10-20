package app

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	ozonerrdomain "github.com/xxww0098/podhub-go/internal/ozonerr/domain"
	ozonerrsvc "github.com/xxww0098/podhub-go/internal/ozonerr/service"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/seller"
)

func TestMountedWarehouseKillSwitchAndCapability(t *testing.T) {
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "")
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY_PREVIOUS", "")
	cfg := config.Load()
	if !cfg.OzonWritesDisabled() {
		t.Fatal("switch")
	}
	owner := chi.NewRouter()
	mountWarehouse(owner, nil, access.FixedResolver{Principal: &access.Principal{UserID: 1, OrgID: 2, WorkspaceRole: "owner"}}, cfg)
	var logs strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(prev)
	rec := postWarehouse(owner, "/api/seller/warehouses/grant", `{"storeId":"11111111-1111-1111-1111-111111111111","clientOperationId":"op","kind":"create"}`)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), `"OZON_WRITES_DISABLED"`) {
		t.Fatal(rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "apiKey") || strings.Contains(logs.String(), "apiKey") || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(rec.Header().Get("Cache-Control"), rec.Body.String(), logs.String())
	}
	rec = postWarehouse(owner, "/api/seller/warehouses/drop-off/list", `{}`)
	if rec.Code != http.StatusNotImplemented || !strings.Contains(rec.Body.String(), `"not_ported"`) {
		t.Fatal(rec.Code, rec.Body.String())
	}

	member := chi.NewRouter()
	mountWarehouse(member, nil, access.FixedResolver{Principal: &access.Principal{UserID: 1, OrgID: 2, WorkspaceRole: "member"}}, cfg)
	rec = postWarehouse(member, "/api/seller/warehouses/grant", `{"storeId":"11111111-1111-1111-1111-111111111111","clientOperationId":"op","kind":"archive","confirm":true,"warehouseId":1}`)
	if rec.Code != http.StatusForbidden {
		t.Fatal(rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "apiKey") || strings.Contains(rec.Body.String(), "OZON_WRITES_DISABLED") {
		t.Fatal(rec.Body.String())
	}
}

func TestWarehouseReadDialsWhenWritesAreDisabled(t *testing.T) {
	const key = "fixture-warehouse-api-key"
	var seen string
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.URL.Path + " " + r.Header.Get("Client-Id") + " " + r.Header.Get("Api-Key")
		if r.URL.Path != "/v2/warehouse/list" {
			http.Error(w, "path", http.StatusBadRequest)
			return
		}
		_, _ = io.WriteString(w, `{"warehouses":[],"has_next":false}`)
	}))
	t.Cleanup(mock.Close)
	t.Setenv("CLOUD_SELLER_BASE_URL", mock.URL+"/")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	cfg := config.Load()
	status, body, err := (egressPoster{eg: seller.New(cfg)}).Post(context.Background(), "/v2/warehouse/list", []byte(`{"limit":200,"warehouse_ids":[]}`), "fixture-client-id", key)
	if err != nil || status != http.StatusOK || !strings.Contains(string(body), "warehouses") {
		t.Fatalf("%d %s %v", status, body, err)
	}
	if seen != "/v2/warehouse/list fixture-client-id "+key {
		t.Fatal(seen)
	}
}

func TestWarehouseCatalogUsesOzonErrorRows(t *testing.T) {
	store := &fakeOzonStore{}
	cat := ozonWarehouseCatalog{svc: ozonerrsvc.New(store)}
	ctx := context.Background()
	cat.RecordOzon(ctx, 4, "/v2/warehouse/list", http.StatusOK, "9")
	cat.RecordOzon(ctx, 4, "wh:11111111-1111-1111-1111-111111111111", http.StatusForbidden, "")
	cat.RecordOzon(ctx, 4, "wh:22222222-2222-2222-2222-222222222222", http.StatusUnprocessableEntity, "OZON_ROW_REJECTED")
	cat.RecordOzon(ctx, 4, "/v2/warehouse/list", http.StatusOK, "")
	if len(store.rows) != 2 {
		t.Fatalf("%+v", store.rows)
	}
	if store.rows[0].Source != ozonerrdomain.SourceRequest || store.rows[0].Code != "9" || store.rows[0].TaskKey != "/v2/warehouse/list" || store.rows[0].Sample != "" {
		t.Fatalf("%+v", store.rows[0])
	}
	if store.rows[1].Code != "7" || store.rows[1].TaskKey != "wh:11111111-1111-1111-1111-111111111111" {
		t.Fatalf("%+v", store.rows[1])
	}
}

type fakeOzonStore struct {
	rows []ozonerrdomain.Row
}

func (f *fakeOzonStore) Insert(_ context.Context, _ int64, rows []ozonerrdomain.Row) (int, error) {
	f.rows = append(f.rows, rows...)
	return len(rows), nil
}

func (f *fakeOzonStore) InsertRequest(context.Context, int64, string, string, string, string) error {
	return nil
}

func (f *fakeOzonStore) ListGlobal(context.Context, int64, ozonerrdomain.Query) ([]ozonerrdomain.Entry, error) {
	return nil, nil
}

func (f *fakeOzonStore) ListOrg(context.Context, int64, ozonerrdomain.Query) ([]ozonerrdomain.Entry, error) {
	return nil, nil
}

func postWarehouse(h http.Handler, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}
