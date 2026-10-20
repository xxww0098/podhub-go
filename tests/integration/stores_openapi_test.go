package integration

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	ratingdomain "github.com/xxww0098/podhub-go/internal/ratings/domain"
	ratinghttp "github.com/xxww0098/podhub-go/internal/ratings/http"
	ratingrepo "github.com/xxww0098/podhub-go/internal/ratings/repo"
	ratingsvc "github.com/xxww0098/podhub-go/internal/ratings/service"
	"github.com/xxww0098/podhub-go/internal/seller"
	storehttp "github.com/xxww0098/podhub-go/internal/store/http"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
	storesvc "github.com/xxww0098/podhub-go/internal/store/service"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestStoreResponsesMatchOpenAPI(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}

	owner, member := int64(97301), int64(97302)
	orgID := seedCompanyOrg(t, ctx, pool, owner, "spec")
	seedCompanyMember(t, ctx, pool, orgID, owner, "owner", 1)
	seedCompanyMember(t, ctx, pool, orgID, member, "member", 2)
	idKeyed := "00000000-0000-4000-8000-0000000000c1"
	idBare := "00000000-0000-4000-8000-0000000000c2"
	seedCompanyStore(t, ctx, pool, orgID, idKeyed, 1, "keyed", nil)
	seedCompanyStore(t, ctx, pool, orgID, idBare, 2, "bare", nil)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"company":{"name":"SPEC","legal_name":"Spec Co","currency":"CNY","country":"CN"},"subscription":{"is_premium":true,"type":"PREMIUM"}}`))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")

	kek := seal.DeriveKEK("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	directory := storerepo.New(pool, tenantx.BeginApp).WithSeal(seal.Ring{Primary: kek}, true)
	svc := storesvc.New(directory, loopSeller{seller.New(config.Load()).WithPool(pool)}).WithCredential(directory).WithRoster(directory)
	var keyedID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM organization_stores WHERE uuid = $1::uuid`, idKeyed).Scan(&keyedID); err != nil {
		t.Fatal(err)
	}
	env, err := seal.SealV1(kek, "k-store", "client-fixture", storeFixtureKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO store_seller_credentials (
			store_id, org_id, credential_revision, client_id, key_id, nonce, ciphertext,
			key_fingerprint, registered_by_user_id, registered_at_ms)
		VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, 1)`,
		keyedID, orgID, env.ClientID, env.KeyID, env.Nonce, env.Ciphertext, env.Fingerprint, owner); err != nil {
		t.Fatal(err)
	}

	var failures []string
	mount := func(s *storehttp.Session, refusal *storehttp.Refusal, actions storehttp.Actions) http.Handler {
		r := chi.NewRouter()
		storehttp.Mount(r, storehttp.Deps{
			Resolve: func(*http.Request) (*storehttp.Session, *storehttp.Refusal, error) { return s, refusal, nil },
			Actions: actions,
			Roster:  svc,
		})
		return spec.Checked(r, func(err error) { failures = append(failures, err.Error()) }, "/api/workspaces/stores/")
	}
	ownerH := mount(&storehttp.Session{UserID: owner, OrgID: orgID, WorkspaceRole: "owner"}, nil, svc)
	memberH := mount(&storehttp.Session{UserID: member, OrgID: orgID, WorkspaceRole: "member"}, nil, svc)
	anonH := mount(nil, nil, svc)
	downH := mount(&storehttp.Session{UserID: owner, OrgID: orgID, WorkspaceRole: "owner"}, nil, nil)

	seedMatchingLease(t, ctx, pool, "entitlement", "store openapi")
	store := "/api/workspaces/stores/"
	cases := []struct {
		name   string
		h      http.Handler
		method string
		path   string
		ctype  string
		body   string
		status int
	}{
		{"rename", ownerH, http.MethodPut, store + idBare, "application/json", `{"name":"renamed","revision":1}`, http.StatusOK},
		{"rename content type", ownerH, http.MethodPut, store + idBare, "text/plain", `{"name":"x","revision":1}`, http.StatusBadRequest},
		{"rename unknown field", ownerH, http.MethodPut, store + idBare, "application/json", `{"name":"x","revision":1,"extra":1}`, http.StatusBadRequest},
		{"rename blank", ownerH, http.MethodPut, store + idBare, "application/json", `{"name":"  ","revision":2}`, http.StatusBadRequest},
		{"rename member", memberH, http.MethodPut, store + idBare, "application/json", `{"name":"x","revision":1}`, http.StatusNotFound},
		{"rename missing", ownerH, http.MethodPut, store + "00000000-0000-4000-8000-0000000000cf", "application/json", `{"name":"x","revision":1}`, http.StatusNotFound},
		{"rename anon", anonH, http.MethodPut, store + idBare, "application/json", `{"name":"x","revision":1}`, http.StatusUnauthorized},
		{"refresh", ownerH, http.MethodPost, store + idKeyed + "/seller-info", "application/json", `{}`, http.StatusOK},
		{"refresh empty body", ownerH, http.MethodPost, store + idKeyed + "/seller-info", "", "", http.StatusOK},
		{"refresh no key", ownerH, http.MethodPost, store + idBare + "/seller-info", "application/json", `{}`, http.StatusConflict},
		{"refresh bad body", ownerH, http.MethodPost, store + idKeyed + "/seller-info", "application/json", `{"x":1}`, http.StatusBadRequest},
		{"refresh member", memberH, http.MethodPost, store + idKeyed + "/seller-info", "application/json", `{}`, http.StatusForbidden},
		{"refresh missing", ownerH, http.MethodPost, store + "00000000-0000-4000-8000-0000000000cf/seller-info", "application/json", `{}`, http.StatusNotFound},
		{"refresh anon", anonH, http.MethodPost, store + idKeyed + "/seller-info", "application/json", `{}`, http.StatusUnauthorized},
		{"refresh down", downH, http.MethodPost, store + idKeyed + "/seller-info", "application/json", `{}`, http.StatusServiceUnavailable},
	}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
		if c.ctype != "" {
			req.Header.Set("Content-Type", c.ctype)
		}
		rec := httptest.NewRecorder()
		c.h.ServeHTTP(rec, req)
		if rec.Code != c.status {
			t.Errorf("%s: status %d want %d: %s", c.name, rec.Code, c.status, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), storeFixtureKey) {
			t.Errorf("%s: response carries the key", c.name)
		}
	}
	for _, f := range failures {
		t.Error(f)
	}
}

func TestRatingResponsesMatchOpenAPI(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}

	owner, other := int64(97303), int64(97304)
	orgID := seedCompanyOrg(t, ctx, pool, owner, "rspec")
	otherOrg := seedCompanyOrg(t, ctx, pool, other, "rspec-other")
	seedCompanyMember(t, ctx, pool, orgID, owner, "owner", 1)
	seedCompanyMember(t, ctx, pool, otherOrg, other, "owner", 1)
	idStore := "00000000-0000-4000-8000-0000000000d1"
	idOther := "00000000-0000-4000-8000-0000000000d2"
	seedCompanyStore(t, ctx, pool, orgID, idStore, 1, "rated", nil)
	seedCompanyStore(t, ctx, pool, otherOrg, idOther, 1, "elsewhere", nil)

	repo := ratingrepo.New(pool)
	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	one, two, half := "1", "2", "0.5"
	if _, err := repo.Apply(ctx, orgID, idStore, []ratingdomain.Rating{
		{Key: "rating_price", Name: "价格指数", ValueType: "INDEX", Status: "OK", Current: &one, Past: &half},
		{Key: "rating_fbo", Name: "Жалобы по FBO", ValueType: "RATIO", Status: ratingdomain.StatusUnknown},
	}, now, ratingdomain.DefaultRanks()); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Apply(ctx, orgID, idStore, []ratingdomain.Rating{
		{Key: "rating_price", Name: "价格指数", ValueType: "INDEX", Status: "OK", Current: &two, Past: &one},
	}, now.Add(time.Minute), ratingdomain.DefaultRanks()); err != nil {
		t.Fatal(err)
	}
	svc := ratingsvc.New(repo)

	var failures []string
	mount := func(res access.Resolver, s *ratingsvc.Service) http.Handler {
		r := chi.NewRouter()
		ratinghttp.Mount(r, ratinghttp.Deps{Access: res, Svc: s})
		return spec.Checked(r, func(err error) { failures = append(failures, err.Error()) }, "/api/workspaces/stores/")
	}
	ownerP := access.Principal{UserID: owner, OrgID: orgID, WorkspaceRole: "owner"}
	ownerH := mount(access.FixedResolver{Principal: &ownerP}, svc)
	anonH := mount(access.FixedResolver{}, svc)
	refusedH := mount(access.FixedResolver{Refusal: &access.Refusal{Status: http.StatusForbidden, Message: "no"}}, svc)
	noOrgH := mount(access.FixedResolver{Principal: &access.Principal{UserID: owner, WorkspaceRole: "owner"}}, svc)
	brokenH := mount(access.FixedResolver{Err: errors.New("session store down")}, svc)
	downH := mount(access.FixedResolver{Principal: &ownerP}, nil)

	base := "/api/workspaces/stores/" + idStore
	cases := []struct {
		name   string
		h      http.Handler
		path   string
		status int
		want   string
	}{
		{"list", ownerH, base + "/ratings", http.StatusOK, `"current_value":2`},
		{"list no data", ownerH, base + "/ratings", http.StatusOK, `"current_value":null`},
		{"list other org", ownerH, "/api/workspaces/stores/" + idOther + "/ratings", http.StatusNotFound, ""},
		{"list bad uuid", ownerH, "/api/workspaces/stores/nope/ratings", http.StatusNotFound, ""},
		{"list anon", anonH, base + "/ratings", http.StatusUnauthorized, ""},
		{"list refused", refusedH, base + "/ratings", http.StatusForbidden, ""},
		{"list no org", noOrgH, base + "/ratings", http.StatusForbidden, ""},
		{"list broken", brokenH, base + "/ratings", http.StatusInternalServerError, ""},
		{"list down", downH, base + "/ratings", http.StatusServiceUnavailable, ""},
		{"history page", ownerH, base + "/ratings/history?limit=1", http.StatusOK, `"next_cursor":`},
		{"history last", ownerH, base + "/ratings/history?limit=100&rating_key=rating_price", http.StatusOK, `"next_cursor":null`},
		{"history bad limit", ownerH, base + "/ratings/history?limit=0", http.StatusBadRequest, ""},
		{"history bad cursor", ownerH, base + "/ratings/history?cursor=x", http.StatusBadRequest, ""},
		{"history other org", ownerH, "/api/workspaces/stores/" + idOther + "/ratings/history", http.StatusNotFound, ""},
		{"history anon", anonH, base + "/ratings/history", http.StatusUnauthorized, ""},
		{"history down", downH, base + "/ratings/history", http.StatusServiceUnavailable, ""},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		c.h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, c.path, nil))
		if rec.Code != c.status || !strings.Contains(rec.Body.String(), c.want) {
			t.Errorf("%s: status %d want %d: %s", c.name, rec.Code, c.status, rec.Body.String())
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("%s: cache-control %q", c.name, rec.Header().Get("Cache-Control"))
		}
	}
	for _, f := range failures {
		t.Error(f)
	}
}
