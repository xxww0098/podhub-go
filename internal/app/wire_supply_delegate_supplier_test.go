package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	configdoc "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
)

func TestPR8ARoutesRequireASession(t *testing.T) {
	handler := Handler(nil)
	for _, path := range []string{"/api/platform-catalog", "/api/supplier/me", "/api/seller/delegate/sources"} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %d %s", path, rec.Code, rec.Body.Bytes())
		}
	}
}

func TestCatalogImagesUseConfiguredAssetsStorage(t *testing.T) {
	ctx, pool := snapshotPool(t)
	cfg := config.Config{IntegrationConfigKey: snapshotTestKey}
	for _, role := range []string{"assets", "private"} {
		t.Run(role, func(t *testing.T) {
			raw, err := json.Marshal(configdoc.Snapshot{SchemaVersion: 1, AIRuntime: configdoc.DefaultAIRuntime(), SystemStorage: []configdoc.StoredStorage{storageFixture(role)}})
			if err != nil {
				t.Fatal(err)
			}
			storeSnapshot(t, ctx, pool, raw)
			h := chi.NewRouter()
			mountPR8A(h, pool, catalogImageSession{}, cfg)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/supplier-dbs/catalog/images/src_test/"+strings.Repeat("a", 64)+".jpg", nil))
			missingStorage := strings.Contains(rec.Body.String(), "STORAGE_NOT_CONFIGURED")
			wantStatus := http.StatusNotFound // No product references this image.
			if role != "assets" {
				wantStatus = http.StatusServiceUnavailable
			}
			if rec.Code != wantStatus || missingStorage != (role != "assets") {
				t.Fatalf("role=%s status=%d body=%s", role, rec.Code, rec.Body.String())
			}
		})
	}
}

type catalogImageSession struct{}

func (catalogImageSession) Resolve(*http.Request) (*access.Principal, *access.Refusal, error) {
	return &access.Principal{UserID: 1, OrgID: 1}, nil, nil
}
