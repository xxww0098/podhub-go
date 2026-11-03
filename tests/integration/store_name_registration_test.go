package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	seller "github.com/xxww0098/podhub-go/internal/seller/ozon"
	"github.com/xxww0098/podhub-go/internal/store/domain"
	storehttp "github.com/xxww0098/podhub-go/internal/store/http"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
	storesvc "github.com/xxww0098/podhub-go/internal/store/service"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestStoreNameFromCredentialRegistration(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "entitlement", "store automatic name")
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	var mode atomic.Value
	var sellerReads atomic.Int64
	mode.Store("ready")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/seller/info" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		sellerReads.Add(1)
		switch mode.Load() {
		case "denied":
			w.WriteHeader(http.StatusUnauthorized)
		case "failed":
			w.WriteHeader(http.StatusServiceUnavailable)
		case "missing":
			_, _ = w.Write([]byte(`{"company":{}}`))
		default:
			_, _ = w.Write([]byte(`{"company":{"name":"Seller 店铺名","legal_name":"Fixture Company"}}`))
		}
	}))
	t.Cleanup(upstream.Close)
	t.Setenv("CLOUD_SELLER_BASE_URL", upstream.URL+"/")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	ring := seal.Ring{Primary: seal.DeriveKEK("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")}
	directory := storerepo.New(pool, tenantx.BeginApp).WithCredentialKey(ring, true, seal.DefaultSellerKeyID,
		storeCredentialProbe(func(context.Context, string, string) (int, []byte, error) {
			return http.StatusOK, []byte(`{}`), nil
		}))
	svc := storesvc.New(directory, loopSeller{seller.New(config.Load()).WithPool(pool)}).
		WithRoster(directory).WithCredentialDirectory(directory)

	for i, tc := range []struct {
		name, supplied, mode, want, source string
		filled                             bool
	}{
		{"omitted", "", "ready", "Seller 店铺名", domain.SourceAuto, true},
		{"whitespace", "  ", "ready", "Seller 店铺名", domain.SourceAuto, true},
		{"manual", "手工名称", "ready", "手工名称", domain.SourceManual, false},
		{"unavailable", "", "failed", "新店铺", domain.SourceAuto, false},
		{"missing name", "", "missing", "新店铺", domain.SourceAuto, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mode.Store(tc.mode)
			owner := int64(97850 + i)
			orgID := seedCompanyOrg(t, ctx, pool, owner, fmt.Sprintf("name-register-%d", i))
			seedCompanyMember(t, ctx, pool, orgID, owner, "owner", 1)
			router := chi.NewRouter()
			storehttp.Mount(router, storehttp.Deps{
				Resolve: func(*http.Request) (*storehttp.Session, *storehttp.Refusal, error) {
					return &storehttp.Session{UserID: owner, OrgID: orgID, WorkspaceRole: "owner"}, nil, nil
				},
				Actions: svc, Roster: svc, Credential: svc,
			})
			handler := spec.Checked(router, func(err error) { t.Error(err) }, storehttp.PathRoster)
			createBody := `{}`
			if tc.supplied != "" {
				body, _ := json.Marshal(map[string]string{"name": tc.supplied})
				createBody = string(body)
			}
			request := func(path, body string) *httptest.ResponseRecorder {
				req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)).WithContext(ctx)
				req.Header.Set("Content-Type", "application/json")
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, req)
				return rec
			}
			post := func(path, body string) *httptest.ResponseRecorder {
				rec := request(path, body)
				if rec.Code != http.StatusOK {
					t.Fatalf("POST %s: %d %s", path, rec.Code, rec.Body.String())
				}
				return rec
			}
			if i == 0 {
				lookupBody := fmt.Sprintf(`{"client_id":"%d","api_key":"fixture-name-key"}`, owner)
				if rec := post(storehttp.PathCredentialName, lookupBody); strings.TrimSpace(rec.Body.String()) != `{"name":"Seller 店铺名"}` {
					t.Fatal(rec.Body.String())
				}
				var count int
				if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.organization_stores WHERE org_id=$1`, orgID).Scan(&count); err != nil || count != 0 {
					t.Fatalf("name lookup persisted a store: count=%d err=%v", count, err)
				}
				for _, failure := range []struct {
					mode   string
					status int
				}{{"failed", 502}, {"missing", 400}, {"denied", 400}} {
					mode.Store(failure.mode)
					if rec := request(storehttp.PathCredentialName, lookupBody); rec.Code != failure.status || strings.Contains(rec.Body.String(), "fixture-name-key") {
						t.Fatalf("lookup %s: %d %s", failure.mode, rec.Code, rec.Body.String())
					}
				}
				mode.Store("ready")
			}
			var created struct {
				Store struct {
					UUID     string `json:"uuid"`
					Revision int64  `json:"revision"`
				} `json:"store"`
			}
			if err := json.Unmarshal(post(storehttp.PathRoster, createBody).Body.Bytes(), &created); err != nil {
				t.Fatal(err)
			}
			body := fmt.Sprintf(`{"client_id":"%d","api_key":"fixture-name-key","confirm_upload":true,"expected_store_revision":%d}`,
				owner, created.Store.Revision)
			var registered struct {
				NameFilled bool  `json:"name_filled"`
				Revision   int64 `json:"revision"`
			}
			if err := json.Unmarshal(post(storehttp.PathRoster+"/"+created.Store.UUID+"/credential", body).Body.Bytes(), &registered); err != nil {
				t.Fatal(err)
			}
			if registered.NameFilled != tc.filled {
				t.Fatalf("name_filled=%v want %v", registered.NameFilled, tc.filled)
			}
			short, legal := "", ""
			if tc.mode == "ready" {
				short, legal = "Seller 店铺名", "Fixture Company"
			}
			assertStore(t, ctx, pool, created.Store.UUID, tc.want, short, legal, tc.source)
			if i == 0 {
				lookupBody := fmt.Sprintf(`{"store_uuid":%q,"client_id":"%d","api_key":""}`, created.Store.UUID, owner)
				post(storehttp.PathCredentialName, lookupBody)
				assertStore(t, ctx, pool, created.Store.UUID, tc.want, short, legal, tc.source)
				before := sellerReads.Load()
				if _, api := svc.ResolveCredentialName(ctx, orgID, owner, created.Store.UUID, "different-id", ""); api == nil || api.Status != 400 {
					t.Fatalf("mismatched held-key Client ID: %v", api)
				}
				if _, api := svc.ResolveCredentialName(ctx, orgID+100000, owner, created.Store.UUID, fmt.Sprint(owner), ""); api == nil {
					t.Fatal("cross-workspace key lookup allowed")
				}
				if sellerReads.Load() != before {
					t.Fatal("unauthorized held-key lookup reached Seller")
				}
			}
			if tc.mode != "ready" {
				mode.Store("ready")
				if _, api := svc.TestCredential(ctx, orgID, owner, created.Store.UUID); api != nil {
					t.Fatal(api)
				}
				assertStore(t, ctx, pool, created.Store.UUID, "Seller 店铺名", "Seller 店铺名", "Fixture Company", domain.SourceAuto)
			}
			manual := "手动调整后名称"
			if _, _, api := svc.UpdateStore(ctx, orgID, owner, "owner", created.Store.UUID, domain.UpdateStoreInput{
				Name: &manual, Revision: registered.Revision,
			}); api != nil {
				t.Fatal(api)
			}
			stale := "过时的回填名称"
			if _, err := directory.SaveCompany(ctx, orgID, created.Store.UUID, domain.Patch{Name: &stale}); err != nil {
				t.Fatal(err)
			}
			if _, api := svc.TestCredential(ctx, orgID, owner, created.Store.UUID); api != nil {
				t.Fatal(api)
			}
			assertStore(t, ctx, pool, created.Store.UUID, manual, "Seller 店铺名", "Fixture Company", domain.SourceManual)
		})
	}
}
