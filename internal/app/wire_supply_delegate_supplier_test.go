package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
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
	for _, role := range []string{"assets", "private"} {
		t.Run(role, func(t *testing.T) {
			cfg := config.Config{R2Storage: []config.R2StorageAccount{storageFixture(role)}}
			h := chi.NewRouter()
			mountPR8A(h, nil, catalogImageSession{}, cfg)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/supplier-dbs/catalog/images/src_test/"+strings.Repeat("a", 64)+".jpg", nil))
			missingStorage := strings.Contains(rec.Body.String(), "STORAGE_NOT_CONFIGURED")
			wantStatus := http.StatusInternalServerError // The nil database stops configured storage before network I/O.
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
