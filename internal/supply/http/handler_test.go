package supplyhttp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/supply/contract"
	"github.com/xxww0098/podhub-go/tests/parity"
)

type fixedSession struct {
	userID int64
	orgID  int64
	role   string
}

func (f fixedSession) Resolve(*http.Request) (*Principal, *Refusal, error) {
	return &Principal{UserID: f.userID, OrgID: f.orgID, WorkspaceRole: f.role}, nil, nil
}

type spy struct{}

func (s *spy) PublicCatalog(context.Context) (contract.PublicCatalogData, error) {
	return contract.PublicCatalogData{Products: []contract.PublicProduct{{
		ProductID: "p", Title: "公开短袖", Description: "卖家可见描述",
		Media: []string{"https://example.test/cover.jpg"}, Specs: contract.Object{}, SKUs: []contract.PublicSKU{},
	}}}, nil
}
func (s *spy) SellerCatalog(context.Context, int64) (contract.SellerCatalogData, error) {
	return contract.SellerCatalogData{Products: []contract.SellerProduct{}}, nil
}
func (s *spy) SellerProduct(context.Context, int64, string) (contract.SellerProduct, error) {
	return contract.SellerProduct{ProductID: "p", Title: "t", Media: []string{}, Specs: contract.Object{}, Publication: "published", SKUs: []contract.SellerSKU{}}, nil
}

type fatalTrip struct{ t *testing.T }

func (f fatalTrip) RoundTrip(*http.Request) (*http.Response, error) {
	f.t.Fatal("dialed")
	return nil, nil
}

func owner() fixedSession {
	return fixedSession{userID: 7, orgID: 3, role: "owner"}
}

func TestSupplyRoutes(t *testing.T) {
	actions := &spy{}
	r := chi.NewRouter()
	Mount(r, Deps{Session: owner(), Actions: actions, Outbound: fatalTrip{t}})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/public/platform-catalog", nil))
	want := `{"data":{"products":[{"productId":"p","title":"公开短袖","description":"卖家可见描述","media":["https://example.test/cover.jpg"],"specs":{},"skus":[]}]}}`
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: 200, Body: []byte(want)}); err != nil {
		t.Fatal(err)
	}
	if rec.Header().Get("Cache-Control") != "public, max-age=60, stale-while-revalidate=300" {
		t.Fatal(rec.Header().Get("Cache-Control"))
	}
	if strings.Contains(strings.ToLower(rec.Body.String()), "price") {
		t.Fatal(rec.Body.String())
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/platform-catalog", nil))
	if rec.Code != 200 || rec.Header().Get("Cache-Control") != "" {
		t.Fatalf("seller cache %d %q", rec.Code, rec.Header().Get("Cache-Control"))
	}

	anon := chi.NewRouter()
	Mount(anon, Deps{Actions: actions, Outbound: fatalTrip{t}})
	rec = httptest.NewRecorder()
	anon.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/platform-catalog", nil))
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: 401, Body: []byte(`{"error":"未登录","code":"AUTH_INVALID"}`)}); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	anon.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/public/platform-catalog", nil))
	if rec.Code != 200 {
		t.Fatalf("public anon %d", rec.Code)
	}

	nows := chi.NewRouter()
	Mount(nows, Deps{Session: fixedSession{userID: 7}, Actions: actions})
	rec = httptest.NewRecorder()
	nows.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/platform-catalog", nil))
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), access.MsgNoWorkspace) {
		t.Fatalf("workspace %d %s", rec.Code, rec.Body.Bytes())
	}

	bad := chi.NewRouter()
	Mount(bad, Deps{Session: fixedSession{userID: 7, orgID: 3, role: "boss"}, Actions: actions})
	rec = httptest.NewRecorder()
	bad.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/platform-catalog", nil))
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), access.MsgBadWorkspaceRole) {
		t.Fatalf("role %d %s", rec.Code, rec.Body.Bytes())
	}
}

func TestOpenAPIListsSupplyRoutes(t *testing.T) {
	raw := string(mustRead(t, filepath.Join(moduleRoot(t), "api/openapi.yaml")))
	for _, rt := range routes {
		if !strings.Contains(raw, "  \""+rt.path+"\":") {
			t.Fatalf("openapi missing %s", rt.path)
		}
	}
	if !strings.Contains(raw, "      - platform") {
		t.Fatal("platform tag")
	}
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod")
		}
		dir = parent
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
