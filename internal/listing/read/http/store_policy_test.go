package readhttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func TestStorePolicyHTTPPersistsWithOrdinaryRoleAndChecksAuthority(t *testing.T) {
	pool, ctx := listingBatchDB(t)
	org, _, _ := seedOwner(t, ctx, pool, "policy-http-"+uuid.NewString())
	user := insertUser(t, ctx, pool, "policy-manager-"+uuid.NewString())
	insertMember(t, ctx, pool, org, user, "manager", 2)
	storeID := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO organization_stores(org_id,uuid,create_order,name) VALUES($1,$2::uuid,1,'policy')`, org, storeID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'store-policy-api'`); err != nil {
		t.Fatal(err)
	}
	cfg := pool.Config().Copy()
	cfg.ConnConfig.User, cfg.ConnConfig.Password = "podhub_login_api", "store-policy-api"
	apiPool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer apiPool.Close()
	host := listingHost(apiPool, org, user)
	host.Access = access.FixedResolver{Principal: &access.Principal{UserID: user, OrgID: org, WorkspaceRole: "manager", PlatformRole: "user"}}
	router := chi.NewRouter()
	router.Get("/api/listing/store-policies/{store_id}", host.getStorePolicy)
	router.Put("/api/listing/store-policies/{store_id}", host.putStorePolicy)
	call := func(method, store, body string) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(method, "/api/listing/store-policies/"+store, strings.NewReader(body)).WithContext(ctx))
		return rec
	}
	jobID := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO jobs(id,org_id,kind,aggregate_type,aggregate_id,input_revision,idempotency_key,state,payload,lane,submitter_user_id,run_at,last_error_code)
		VALUES($1::uuid,$2,'listing.submit.batch','submission_batch',$1::uuid,0,$1,'retry_wait',jsonb_build_object('storeId',$4::text,'intents','[]'::jsonb),'listing.submit.batch',$3,clock_timestamp()+interval '1 day','STORE_DAILY_CAP_REACHED')`, jobID, org, user, storeID); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`null`, `{"daily_cap":0}`, `{"daily_cap":1.1}`, `{"min_gap_seconds":-1}`, `{"min_gap_seconds":86401}`, `{"extra":true}`} {
		if rec := call(http.MethodPut, storeID, body); rec.Code != http.StatusBadRequest {
			t.Fatalf("accepted invalid policy %s: %d %s", body, rec.Code, rec.Body.String())
		}
	}
	for _, method := range []string{http.MethodPut, http.MethodGet} {
		rec := call(method, storeID, `{"daily_cap":12,"min_gap_seconds":30}`)
		var got storePolicy
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &got) != nil || got.DailyCap == nil || *got.DailyCap != 12 || got.MinGapSeconds != 30 || !got.CanManage || got.Timezone != "Asia/Shanghai" {
			t.Fatalf("policy did not persist: %d %s", rec.Code, rec.Body.String())
		}
	}
	var cap, gap int
	if err := pool.QueryRow(ctx, `SELECT daily_cap,min_gap_seconds FROM store_listing_policies WHERE org_id=$1`, org).Scan(&cap, &gap); err != nil || cap != 12 || gap != 30 {
		t.Fatalf("independent read: cap=%d gap=%d err=%v", cap, gap, err)
	}
	var waitingRechecked bool
	if err := pool.QueryRow(ctx, `SELECT state='retry_wait' AND run_at<=clock_timestamp() FROM jobs WHERE id=$1::uuid`, jobID).Scan(&waitingRechecked); err != nil || !waitingRechecked {
		t.Fatalf("updated policy did not wake waiting work: %v %v", waitingRechecked, err)
	}
	foreignOrg, _, _ := seedOwner(t, ctx, pool, "foreign-policy-"+uuid.NewString())
	foreignStore := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO organization_stores(org_id,uuid,create_order,name) VALUES($1,$2::uuid,1,'foreign')`, foreignOrg, foreignStore); err != nil {
		t.Fatal(err)
	}
	if rec := call(http.MethodGet, foreignStore, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("foreign store leaked: %d %s", rec.Code, rec.Body.String())
	}
	if rec := call(http.MethodGet, uuid.NewString(), ""); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown store leaked: %d %s", rec.Code, rec.Body.String())
	}
	// The resolved principal is deliberately stale; the current seat wins.
	if _, err := pool.Exec(ctx, `UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2`, org, user); err != nil {
		t.Fatal(err)
	}
	if rec := call(http.MethodPut, storeID, `{"daily_cap":99,"min_gap_seconds":0}`); rec.Code != http.StatusForbidden && rec.Code != http.StatusNotFound {
		t.Fatalf("demoted owner changed policy: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := pool.Exec(ctx, `UPDATE organization_members SET role='manager',manual_disabled=true WHERE org_id=$1 AND user_id=$2`, org, user); err != nil {
		t.Fatal(err)
	}
	if rec := call(http.MethodGet, storeID, ""); rec.Code != http.StatusForbidden {
		t.Fatalf("disabled seat read policy: %d %s", rec.Code, rec.Body.String())
	}
}
