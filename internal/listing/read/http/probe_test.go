package readhttp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestManualProbeRejectsUnreadableResponsesAndSettlesVerifiedResults(t *testing.T) {
	pool, ctx := listingBatchDB(t)
	if _, err := pool.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'probe-read-login'`); err != nil {
		t.Fatal(err)
	}
	cfg := pool.Config().Copy()
	cfg.ConnConfig.User, cfg.ConnConfig.Password = "podhub_login_api", "probe-read-login"
	apiPool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer apiPool.Close()
	for _, tc := range []struct {
		name, body, state string
		closed            bool
	}{
		{"missing items", `{}`, "unknown", false},
		{"null response", `null`, "unknown", false},
		{"null items", `{"items":null}`, "unknown", false},
		{"wrong envelope", `{"result":{"items":[]}}`, "unknown", false},
		{"invalid product", `{"items":[{"id":0,"offer_id":"a"}]}`, "unknown", false},
		{"foreign offer", `{"items":[{"id":1,"offer_id":"other"}]}`, "unknown", false},
		{"duplicate offer", `{"items":[{"id":1,"offer_id":"a"},{"id":2,"offer_id":"a"}]}`, "unknown", false},
		{"verified absence", `{"items":[]}`, "superseded", true},
		{"verified product", `{"items":[{"id":9,"offer_id":"a","sources":[{"sku":10}]}]}`, "accepted", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			host, id, org := probeFixture(t, pool, apiPool, ctx)
			calls := 0
			host.Seller = func(context.Context, string, []byte, string, string) (int, []byte, error) {
				calls++
				return http.StatusOK, []byte(tc.body), nil
			}
			router := chi.NewRouter()
			Mount(router, host)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/listing/intents/"+id+"/probe", nil).WithContext(ctx))
			if rec.Code != http.StatusOK || calls != 1 {
				t.Fatalf("probe status=%d calls=%d body=%s", rec.Code, calls, rec.Body.String())
			}
			assertProbeEffects(t, pool, ctx, org, id, tc.state, tc.closed)
		})
	}
}

func TestManualProbeIgnoresReplacedClaim(t *testing.T) {
	pool, ctx := listingBatchDB(t)
	host, id, org := probeFixture(t, pool, pool, ctx)
	host.Seller = func(context.Context, string, []byte, string, string) (int, []byte, error) {
		if _, err := pool.Exec(ctx, `UPDATE submission_intents SET reconcile_claim_until=reconcile_claim_until+interval '1 minute' WHERE id=$1::uuid`, id); err != nil {
			t.Fatal(err)
		}
		return http.StatusOK, []byte(`{"items":[]}`), nil
	}
	router := chi.NewRouter()
	Mount(router, host)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/listing/intents/"+id+"/probe", nil).WithContext(ctx))
	if rec.Code != http.StatusOK {
		t.Fatalf("probe status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertProbeEffects(t, pool, ctx, org, id, "unknown", false)
}

func TestOperatorReleaseSettlesEffectOnceUnderTenantRole(t *testing.T) {
	pool, ctx := listingBatchDB(t)
	host, id, org := probeFixture(t, pool, pool, ctx)
	router := chi.NewRouter()
	Mount(router, host)
	for _, want := range []int{1, 0} {
		rec := httptest.NewRecorder()
		body := fmt.Sprintf(`{"intentIds":[%q]}`, id)
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/listing/intents/release-unknown", strings.NewReader(body)).WithContext(ctx))
		if rec.Code != http.StatusOK {
			t.Fatalf("release status=%d body=%s", rec.Code, rec.Body.String())
		}
		var response struct {
			Data struct {
				Released []string `json:"released_intent_ids"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil || len(response.Data.Released) != want {
			t.Fatalf("release result=%s err=%v", rec.Body.String(), err)
		}
		assertProbeEffects(t, pool, ctx, org, id, "superseded", true)
	}
}

func probeFixture(t *testing.T, pool, apiPool *pgxpool.Pool, ctx context.Context) (Host, string, int64) {
	t.Helper()
	org, user, row := seedOwner(t, ctx, pool, "probe-"+uuid.NewString())
	store, id := uuid.NewString(), uuid.NewString()
	var storePK int64
	if err := pool.QueryRow(ctx, `INSERT INTO organization_stores(org_id,uuid,create_order,name) VALUES($1,$2::uuid,1,'probe') RETURNING id`, org, store).Scan(&storePK); err != nil {
		t.Fatal(err)
	}
	var revision int64
	if err := pool.QueryRow(ctx, `UPDATE listing_rows SET store_id=$3::uuid,submission_state='unknown' WHERE org_id=$1 AND id=$2::uuid RETURNING revision`, org, row, store).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO submission_intents(id,org_id,store_id,listing_row_id,row_revision,client_operation_id,request_hash,state,last_error_code,offer_id,reconciliation_outcome) VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5,$1,'hash','unknown','OZON_RECONCILE_STILL_UNKNOWN','a','{"probe":{"passes":8,"observation":"absent"}}')`, id, org, store, row, revision); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO seller_upstream_writes(org_id,store_id,idempotency_key,request_hash,state,kind) VALUES($1,$2,$3,'hash','result_unknown','import')`, org, storePK, id); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO seller_resource_occupancies(org_id,store_pk,physical_account_key,resource_kind,resource_key,owner_kind,owner_ref,spec_digest) VALUES($1,$2,$3,'offer','a','store_write',$4,'hash')`, org, storePK, store, id); err != nil {
		t.Fatal(err)
	}
	ring := seal.Ring{Primary: seal.DeriveKEK("local-probe-test-key")}
	env, err := seal.SealV1(ring.Primary, "probe", "probe-client", "probe-key")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO store_seller_credentials(store_id,org_id,credential_revision,client_id,key_id,nonce,ciphertext,key_fingerprint,registered_by_user_id,registered_at_ms) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,1)`, storePK, org, env.ClientID, env.KeyID, env.Nonce, env.Ciphertext, env.Fingerprint, user); err != nil {
		t.Fatal(err)
	}
	host := claimHost(apiPool, org, user)
	host.Seals = ring
	return host, id, org
}

func assertProbeEffects(t *testing.T, pool *pgxpool.Pool, ctx context.Context, org int64, id, state string, closed bool) {
	t.Helper()
	var actual, write, occupancy string
	if err := pool.QueryRow(ctx, `SELECT i.state,w.state,o.state FROM submission_intents i
	 JOIN seller_upstream_writes w ON w.org_id=i.org_id AND w.idempotency_key=i.id::text
	 JOIN seller_resource_occupancies o ON o.org_id=i.org_id AND o.owner_ref=i.id::text
	 WHERE i.org_id=$1 AND i.id=$2::uuid`, org, id).Scan(&actual, &write, &occupancy); err != nil {
		t.Fatal(err)
	}
	wantWrite, wantOccupancy := "result_unknown", "held"
	if closed {
		wantWrite, wantOccupancy = "reconciled", "released"
	}
	if actual != state || write != wantWrite || occupancy != wantOccupancy {
		t.Fatalf("intent=%s write=%s occupancy=%s; want %s/%s/%s", actual, write, occupancy, state, wantWrite, wantOccupancy)
	}
}
