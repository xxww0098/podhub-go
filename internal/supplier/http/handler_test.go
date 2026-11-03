package supplierhttp

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
	"github.com/xxww0098/podhub-go/internal/supplier/domain"
	"github.com/xxww0098/podhub-go/tests/parity"
)

type fixedSession struct {
	userID  int64
	orgID   int64
	refusal *Refusal
	err     error
}

func (f fixedSession) Resolve(*http.Request) (*Principal, *Refusal, error) {
	if f.err != nil || f.refusal != nil {
		return nil, f.refusal, f.err
	}
	return &Principal{UserID: f.userID, OrgID: f.orgID}, nil, nil
}

type spy struct {
	accepts              int
	me                   contract.MeData
	source, view, search string
	status, reason       string
	cursor               domain.Cursor
	at                   time.Time
}

func (s *spy) Me(context.Context, int64) (contract.MeData, error) { return s.me, nil }
func (s *spy) ListDispatches(_ context.Context, _ int64, source, view, search, status, reason string, cursor domain.Cursor, now time.Time) (contract.DispatchListData, error) {
	s.source, s.view, s.search, s.status, s.reason, s.cursor, s.at = source, view, search, status, reason, cursor, now
	return contract.DispatchListData{Dispatches: []contract.DispatchRow{}, Cursor: "", HasMore: false}, nil
}
func (s *spy) Dashboard(context.Context, int64, string, time.Time) (contract.DashboardData, error) {
	return contract.DashboardData{UrgentOrders: []contract.DispatchRow{}}, nil
}
func (s *spy) GetDispatch(context.Context, int64, string) (contract.DispatchDetail, error) {
	return contract.DispatchDetail{}, nil
}
func (s *spy) Accept(context.Context, int64, string) (contract.ActionData, error) {
	s.accepts++
	return contract.ActionData{DispatchID: "11111111-1111-4111-8111-111111111111", State: "accepted"}, nil
}
func (s *spy) Reject(context.Context, int64, string, string) (contract.ActionData, error) {
	return contract.ActionData{}, nil
}
func (s *spy) Ship(context.Context, int64, string, string, string, int64) (contract.ActionData, error) {
	return contract.ActionData{}, nil
}
func (s *spy) DownloadAsset(context.Context, int64, string, string, bool, int64) (contract.DownloadGrant, error) {
	return contract.DownloadGrant{URL: "http://127.0.0.1/x", ExpiresAtMs: 1}, nil
}
func (s *spy) Catalog(context.Context, int64, int64) (contract.CatalogData, error) {
	return contract.CatalogData{DBs: []contract.SourceCard{}, PropDefs: []contract.PropDef{}, Rows: []contract.CatalogRow{}}, nil
}
func (s *spy) CatalogImage(context.Context, string, string, uint32) (contract.ImageBody, error) {
	return contract.ImageBody{ContentType: "image/jpeg", Bytes: []byte("img")}, nil
}

type fatalTrip struct{ t *testing.T }

func (f fatalTrip) RoundTrip(*http.Request) (*http.Response, error) {
	f.t.Fatal("dialed")
	return nil, nil
}

func TestSupplierAuthAndValidation(t *testing.T) {
	actions := &spy{me: contract.MeData{Sources: []contract.SourceCard{{SourceID: "s", Name: "厂", Country: "CN", Icon: ""}}}}
	r := chi.NewRouter()
	Mount(r, Deps{Session: fixedSession{userID: 7}, Actions: actions, Outbound: fatalTrip{t}})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/supplier/me", nil))
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: 200, Body: []byte(`{"data":{"sources":[{"source_id":"s","name":"厂","country":"CN","icon":""}]}}`)}); err != nil {
		t.Fatal(err)
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/supplier/workspaces/s/dispatches?view=rejected", nil))
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: 400, Body: []byte(`{"error":"未知的订单视图","code":"validation"}`)}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/supplier/dispatches/11111111-1111-4111-8111-111111111111/accept", strings.NewReader("not-json"))
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 200 || actions.accepts != 1 || !strings.Contains(rec.Body.String(), `"state":"accepted"`) {
		t.Fatalf("accept %d %s calls %d", rec.Code, rec.Body.Bytes(), actions.accepts)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/supplier/dispatches/11111111-1111-4111-8111-111111111111/reject", strings.NewReader(`{"reason":"x"}`))
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: 400, Body: []byte(`{"error":"请求格式无效","code":"validation"}`)}); err != nil {
		t.Fatal(err)
	}

	anon := chi.NewRouter()
	Mount(anon, Deps{Outbound: fatalTrip{t}})
	rec = httptest.NewRecorder()
	anon.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/supplier/me", nil))
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: 401, Body: []byte(`{"error":"未登录","code":"auth_invalid"}`)}); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	anon.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/supplier-dbs/catalog", nil))
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: 401, Body: []byte(`{"error":"未登录","code":"AUTH_INVALID"}`)}); err != nil {
		t.Fatal(err)
	}

	folded := chi.NewRouter()
	Mount(folded, Deps{Session: fixedSession{refusal: &Refusal{Status: 403, Message: "no"}}, Actions: actions})
	rec = httptest.NewRecorder()
	folded.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/supplier/me", nil))
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: 500, Body: []byte(`{"error":"服务暂不可用","code":"internal"}`)}); err != nil {
		t.Fatal(err)
	}

	img := chi.NewRouter()
	Mount(img, Deps{Session: fixedSession{userID: 7}, Actions: actions, Outbound: fatalTrip{t}})
	file := strings.Repeat("a", 64) + ".jpg"
	rec = httptest.NewRecorder()
	img.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/supplier-dbs/catalog/images/src/"+file+"?edge=100", nil))
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: 400, Body: []byte(`{"error":"缩略图尺寸无效","code":"VALIDATION"}`)}); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	img.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/supplier-dbs/catalog/images/src/"+file, nil))
	if rec.Code != 200 || rec.Body.String() != "img" || rec.Header().Get("Cache-Control") != "private, max-age=31536000, immutable" || rec.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("image %d %q %v", rec.Code, rec.Body.String(), rec.Header())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/supplier/dispatches/11111111-1111-4111-8111-111111111111/assets/22222222-2222-4222-8222-222222222222", nil)
	req.Header.Set("Accept", "application/json")
	img.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"url":"http://127.0.0.1/x"`) || rec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("grant %d %s %s", rec.Code, rec.Body.Bytes(), rec.Header().Get("Cache-Control"))
	}

	broken := chi.NewRouter()
	Mount(broken, Deps{Session: fixedSession{err: errors.New("db")}, Actions: actions})
	rec = httptest.NewRecorder()
	broken.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/supplier/me", nil))
	if rec.Code != 500 || !strings.Contains(rec.Body.String(), `"code":"internal"`) {
		t.Fatalf("resolve %d %s", rec.Code, rec.Body.Bytes())
	}
}

func TestWorkspaceListForwardsValidatedFilters(t *testing.T) {
	actions := &spy{}
	now := time.Date(2026, 10, 29, 8, 0, 0, 0, time.UTC)
	r := chi.NewRouter()
	Mount(r, Deps{Session: fixedSession{userID: 7}, Actions: actions, Now: func() time.Time { return now }})
	path := "/api/supplier/workspaces/factory-a/dispatches?view=urgent&search=%E5%95%86%E5%93%81&status=accepted&reason=nudge"
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if rec.Code != 200 || actions.source != "factory-a" || actions.view != "urgent" || actions.search != "商品" || actions.status != "accepted" || actions.reason != "nudge" || !actions.at.Equal(now) {
		t.Fatalf("response %d %s, forwarded %+v", rec.Code, rec.Body.String(), actions)
	}
	for _, query := range []string{"view=pending&reason=nudge", "view=urgent&status=shipped", "view=urgent&reason=unknown", "view=urgent&cursor=bad"} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/supplier/workspaces/factory-a/dispatches?"+query, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", query, rec.Code, rec.Body.String())
		}
	}
}

func TestOpenAPIListsSupplierRoutes(t *testing.T) {
	raw := string(mustRead(t, filepath.Join(moduleRoot(t), "api/openapi.yaml")))
	for _, rt := range routes {
		if !strings.Contains(raw, "  \""+rt.path+"\":") {
			t.Fatalf("openapi missing %s", rt.path)
		}
	}
	if !strings.Contains(raw, "      - supplier") {
		t.Fatal("supplier tag")
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
