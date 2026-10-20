package integration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/listing/submit"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	queue "github.com/xxww0098/podhub-go/internal/platform/jobsched"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	sellerdomain "github.com/xxww0098/podhub-go/internal/seller/domain"
)

const (
	fixtureClientID = "fixture-client-id"
	fixtureAPIKey   = "fixture-api-key-browser-direct"
	fixtureKeyID    = "fixture-key-id"
	grantTTLMS      = 120000
)

func TestBrowserGrantAndReport(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	var hits atomic.Int32
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Error(w, "unexpected dial", http.StatusInternalServerError)
	}))
	t.Cleanup(mock.Close)

	userA, orgA := insertWorkspace(t, ctx, pool, "grant-a-"+uuid.NewString()+"@example.com", "Grant A")
	userB, orgB := insertWorkspace(t, ctx, pool, "grant-b-"+uuid.NewString()+"@example.com", "Grant B")
	kek := seal.DeriveKEK("browser-direct-fixture-kek")
	ring := seal.Ring{Primary: kek}

	t.Run("writes disabled", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, orgA, userA, ring, true, nil)
		rec := shop.postGrant(t, shop.body("offer-off", "op-off", shop.row(t, ctx)))
		assertNoKey(t, rec, http.StatusServiceUnavailable, "OZON_WRITES_DISABLED")
		if shop.opens.Load() != 0 {
			t.Fatal(shop.opens.Load())
		}
		if n := shop.intentCount(t, ctx); n != 0 {
			t.Fatalf("intents %d", n)
		}
		if n := shop.budgetCount(t, ctx); n != 0 {
			t.Fatalf("budget %d", n)
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(rec.Header().Get("Cache-Control"))
		}
	})

	t.Run("grant then fence report revoke and worker", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, orgA, userA, ring, false, farExpiry())
		beforeJobs := countJobs(t, ctx, pool, orgA)
		row := shop.row(t, ctx)
		rec := shop.postGrant(t, shop.body("offer-live", "op-live", row))
		if rec.Code != http.StatusOK {
			t.Fatalf("grant %d %s", rec.Code, rec.Body.String())
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(rec.Header().Get("Cache-Control"))
		}
		if strings.Count(rec.Body.String(), fixtureAPIKey) != 1 {
			t.Fatalf("key count %d", strings.Count(rec.Body.String(), fixtureAPIKey))
		}
		if strings.Contains(rec.Body.String(), "Client-Id") || strings.Contains(rec.Body.String(), "Api-Key") {
			t.Fatal(rec.Body.String())
		}
		if shop.opens.Load() != 1 {
			t.Fatal(shop.opens.Load())
		}
		parsed := parseGrant(t, rec)
		if parsed.State != "submitting" || parsed.ClientID != fixtureClientID || parsed.APIKey != fixtureAPIKey || parsed.TTL != grantTTLMS {
			t.Fatalf("%+v", parsed)
		}
		var granted int64
		if err := pool.QueryRow(ctx, `
			SELECT (extract(epoch FROM credential_granted_at) * 1000)::bigint
			  FROM public.submission_intents WHERE id = $1::uuid`, parsed.IntentID).Scan(&granted); err != nil {
			t.Fatal(err)
		}
		if parsed.Expires != granted+grantTTLMS {
			t.Fatalf("expires %d granted %d", parsed.Expires, granted)
		}
		if countJobs(t, ctx, pool, orgA) != beforeJobs {
			t.Fatal("grant enqueued a job")
		}
		if n := countUpstream(t, ctx, pool, orgA, parsed.IntentID); n != 0 {
			t.Fatalf("upstream %d", n)
		}
		if shop.budgetCount(t, ctx) != 1 {
			t.Fatal(shop.budgetCount(t, ctx))
		}
		var rowState string
		if err := pool.QueryRow(ctx, `SELECT submission_state FROM public.listing_rows WHERE id = $1::uuid`, row).Scan(&rowState); err != nil || rowState != "submitting" {
			t.Fatalf("row %s %v", rowState, err)
		}

		again := shop.postGrant(t, shop.body("offer-live", "op-live-2", shop.row(t, ctx)))
		assertNoKey(t, again, http.StatusConflict, "submission_intents_offer_busy")
		if shop.opens.Load() != 1 {
			t.Fatal(shop.opens.Load())
		}

		bad := shop.postReport(t, `{"intentId":`)
		if bad.Code != http.StatusBadRequest {
			t.Fatalf("bad report %d %s", bad.Code, bad.Body.String())
		}
		if state := intentState(t, ctx, pool, parsed.IntentID); state != "submitting" {
			t.Fatal(state)
		}
		still := shop.postGrant(t, shop.body("offer-live", "op-live-3", shop.row(t, ctx)))
		assertNoKey(t, still, http.StatusConflict, "submission_intents_offer_busy")
		if shop.opens.Load() != 1 {
			t.Fatal(shop.opens.Load())
		}

		okReport := shop.postReport(t, `{"intentId":"`+parsed.IntentID+`","taskId":7}`)
		if okReport.Code != http.StatusOK || !strings.Contains(okReport.Body.String(), `"state":"accepted"`) {
			t.Fatalf("report %d %s", okReport.Code, okReport.Body.String())
		}
		var task, listing string
		if err := pool.QueryRow(ctx, `
			SELECT i.state, i.external_task_id, r.submission_state
			  FROM public.submission_intents i
			  JOIN public.listing_rows r ON r.id = i.listing_row_id
			 WHERE i.id = $1::uuid`, parsed.IntentID).Scan(&rowState, &task, &listing); err != nil {
			t.Fatal(err)
		}
		if rowState != "accepted" || task != "7" || listing != "accepted" {
			t.Fatalf("%s %s %s", rowState, task, listing)
		}
		secondReport := shop.postReport(t, `{"intentId":"`+parsed.IntentID+`","httpStatus":400}`)
		if secondReport.Code != http.StatusConflict {
			t.Fatalf("second report %d %s", secondReport.Code, secondReport.Body.String())
		}
		if state := intentState(t, ctx, pool, parsed.IntentID); state != "accepted" {
			t.Fatal(state)
		}
	})

	t.Run("4xx opens the fence for a new client operation", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, orgA, userA, ring, false, farExpiry())
		first := parseGrant(t, shop.postGrant(t, shop.body("offer-4xx", "op-4xx", shop.row(t, ctx))))
		rec := shop.postReport(t, `{"intentId":"`+first.IntentID+`","httpStatus":400}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("%d %s", rec.Code, rec.Body.String())
		}
		var state, code string
		if err := pool.QueryRow(ctx, `SELECT state, COALESCE(last_error_code, '') FROM public.submission_intents WHERE id = $1::uuid`, first.IntentID).Scan(&state, &code); err != nil {
			t.Fatal(err)
		}
		if state != "rejected" || code != "OZON_ROW_REJECTED" {
			t.Fatalf("%s %s", state, code)
		}
		second := shop.postGrant(t, shop.body("offer-4xx", "op-4xx-2", shop.row(t, ctx)))
		if second.Code != http.StatusOK || strings.Count(second.Body.String(), fixtureAPIKey) != 1 {
			t.Fatalf("%d %s", second.Code, second.Body.String())
		}
		if shop.opens.Load() != 2 {
			t.Fatal(shop.opens.Load())
		}
	})

	t.Run("no status keeps the fence", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, orgA, userA, ring, false, farExpiry())
		first := parseGrant(t, shop.postGrant(t, shop.body("offer-unk", "op-unk", shop.row(t, ctx))))
		rec := shop.postReport(t, `{"intentId":"`+first.IntentID+`"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("%d %s", rec.Code, rec.Body.String())
		}
		var state, code string
		var reconcile *time.Time
		if err := pool.QueryRow(ctx, `
			SELECT state, COALESCE(last_error_code, ''), reconcile_after
			  FROM public.submission_intents WHERE id = $1::uuid`, first.IntentID).Scan(&state, &code, &reconcile); err != nil {
			t.Fatal(err)
		}
		if state != "unknown" || code != "OZON_DISPATCH_INTERRUPTED" || reconcile == nil {
			t.Fatalf("%s %s %v", state, code, reconcile)
		}
		again := shop.postGrant(t, shop.body("offer-unk", "op-unk-2", shop.row(t, ctx)))
		assertNoKey(t, again, http.StatusConflict, "submission_intents_offer_busy")
		if shop.opens.Load() != 1 {
			t.Fatal(shop.opens.Load())
		}
	})

	t.Run("revoked grant returns no key", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, orgA, userA, ring, false, farExpiry())
		first := parseGrant(t, shop.postGrant(t, shop.body("offer-rev", "op-rev", shop.row(t, ctx))))
		if _, err := pool.Exec(ctx, `UPDATE public.submission_intents SET revoked_at = clock_timestamp() WHERE id = $1::uuid`, first.IntentID); err != nil {
			t.Fatal(err)
		}
		again := shop.postGrant(t, shop.body("offer-rev", "op-rev-2", shop.row(t, ctx)))
		assertNoKey(t, again, http.StatusConflict, "grant_revoked")
		if shop.opens.Load() != 1 {
			t.Fatal(shop.opens.Load())
		}
	})

	t.Run("same client operation expires without a second key", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, orgA, userA, ring, false, farExpiry())
		body := shop.body("offer-exp", "op-exp", shop.row(t, ctx))
		first := parseGrant(t, shop.postGrant(t, body))
		if _, err := pool.Exec(ctx, `UPDATE public.submission_intents SET credential_granted_at = timestamptz '2000-01-01' WHERE id = $1::uuid`, first.IntentID); err != nil {
			t.Fatal(err)
		}
		again := shop.postGrant(t, body)
		assertNoKey(t, again, http.StatusConflict, "grant_expired")
		if shop.opens.Load() != 1 {
			t.Fatal(shop.opens.Load())
		}
	})

	t.Run("empty offer is busy", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, orgA, userA, ring, false, farExpiry())
		rec := shop.postGrant(t, shop.body("", "op-empty", shop.row(t, ctx)))
		assertNoKey(t, rec, http.StatusConflict, "submission_intents_offer_busy")
		if shop.opens.Load() != 0 {
			t.Fatal(shop.opens.Load())
		}
		if shop.budgetCount(t, ctx) != 1 {
			t.Fatal(shop.budgetCount(t, ctx))
		}
	})

	t.Run("missing credential stays submitting", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, orgA, userA, ring, false, nil)
		if _, err := pool.Exec(ctx, `DELETE FROM public.store_seller_credentials WHERE store_id = $1`, shop.storePK); err != nil {
			t.Fatal(err)
		}
		rec := shop.postGrant(t, shop.body("offer-miss", "op-miss", shop.row(t, ctx)))
		assertNoKey(t, rec, http.StatusServiceUnavailable, "credential_unavailable")
		if shop.opens.Load() != 0 {
			t.Fatal(shop.opens.Load())
		}
		if n := shop.intentCount(t, ctx); n != 1 {
			t.Fatalf("intents %d", n)
		}
		var state string
		if err := pool.QueryRow(ctx, `SELECT state FROM public.submission_intents WHERE store_id = $1::uuid`, shop.storeID).Scan(&state); err != nil || state != "submitting" {
			t.Fatalf("%s %v", state, err)
		}
		again := shop.postGrant(t, shop.body("offer-miss", "op-miss-2", shop.row(t, ctx)))
		assertNoKey(t, again, http.StatusConflict, "submission_intents_offer_busy")
	})

	t.Run("seller key expiry", func(t *testing.T) {
		past := int64(1)
		shop := newGrantShop(t, ctx, pool, orgA, userA, ring, false, &past)
		rec := shop.postGrant(t, shop.body("offer-old", "op-old", shop.row(t, ctx)))
		assertNoKey(t, rec, http.StatusServiceUnavailable, "credential_expired")
		if shop.opens.Load() != 0 {
			t.Fatal(shop.opens.Load())
		}
		var state string
		if err := pool.QueryRow(ctx, `SELECT state FROM public.submission_intents WHERE store_id = $1::uuid`, shop.storeID).Scan(&state); err != nil || state != "submitting" {
			t.Fatalf("%s %v", state, err)
		}
	})

	t.Run("rate limit", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, orgA, userA, ring, false, farExpiry())
		if _, err := pool.Exec(ctx, `
			INSERT INTO public.lease_budget (namespace, scope, next_at, expires_at)
			VALUES ($1, $2, clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours')`,
			sellerdomain.Namespace(), "browser-grant:"+shop.storeID); err != nil {
			t.Fatal(err)
		}
		rec := shop.postGrant(t, shop.body("offer-rate", "op-rate", shop.row(t, ctx)))
		assertNoKey(t, rec, http.StatusTooManyRequests, "rate_limited")
		if shop.opens.Load() != 0 || shop.intentCount(t, ctx) != 0 {
			t.Fatalf("opens %d intents %d", shop.opens.Load(), shop.intentCount(t, ctx))
		}
	})

	t.Run("cross tenant", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, orgA, userA, ring, false, farExpiry())
		other := shop.handler(orgB, userB, "owner", false)
		rec := callJSON(other, http.MethodPost, "/api/listing/browser/grant", shop.body("offer-x", "op-x", shop.row(t, ctx)))
		assertNoKey(t, rec, http.StatusNotFound, "not_found")
		if shop.opens.Load() != 0 {
			t.Fatal(shop.opens.Load())
		}
		tx, err := tenant.BeginApp(ctx, pool.Begin, orgB)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM public.submission_intents WHERE store_id = $1::uuid`, shop.storeID).Scan(&n); err != nil || n != 0 {
			t.Fatalf("org B sees %d %v", n, err)
		}
	})

	t.Run("reviewer", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, orgA, userA, ring, false, farExpiry())
		h := shop.handler(orgA, userA, "reviewer", false)
		rec := callJSON(h, http.MethodPost, "/api/listing/browser/grant", shop.body("offer-revr", "op-revr", shop.row(t, ctx)))
		assertNoKey(t, rec, http.StatusForbidden, "forbidden")
		if !strings.Contains(rec.Body.String(), "当前角色无权执行此操作") {
			t.Fatal(rec.Body.String())
		}
		if shop.opens.Load() != 0 || shop.budgetCount(t, ctx) != 0 || shop.intentCount(t, ctx) != 0 {
			t.Fatalf("opens %d budget %d intents %d", shop.opens.Load(), shop.budgetCount(t, ctx), shop.intentCount(t, ctx))
		}
	})

	t.Run("bad grant json", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, orgA, userA, ring, false, farExpiry())
		rec := shop.postGrant(t, `{`)
		assertNoKey(t, rec, http.StatusBadRequest, "bad_request")
	})

	t.Run("unknown report", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, orgA, userA, ring, false, farExpiry())
		rec := shop.postReport(t, `{"intentId":"`+uuid.NewString()+`","taskId":1}`)
		assertNoKey(t, rec, http.StatusNotFound, "not_found")
	})

	t.Run("worker does not dial a submitting grant", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, orgA, userA, ring, false, farExpiry())
		row := shop.row(t, ctx)
		first := parseGrant(t, shop.postGrant(t, shop.body("offer-work", "op-work", row)))
		var storePK int64
		if err := pool.QueryRow(ctx, `SELECT id FROM public.organization_stores WHERE uuid = $1::uuid`, shop.storeID).Scan(&storePK); err != nil {
			t.Fatal(err)
		}
		seed := submit.Seed{
			OrgID: orgA, StorePK: storePK, StoreID: shop.storeID,
			IntentID: first.IntentID, RowID: row, OfferID: "offer-work",
			RequestHash: "hash-offer-work", RowRevision: 1,
		}
		lease := runningJob(t, ctx, pool, seed, userA, false)
		tr := &tallyTransport{}
		err := submit.Work(ctx, pool, queue.Claimed{
			ID: lease.ID, OrgID: orgA, Kind: "listing.submit", SubmitterUserID: userA,
			Attempt: 1, MaxAttempts: 8, Epoch: lease.Epoch, Owner: lease.Owner,
			Payload: jobPayload(seed, false),
		}, tr)
		if err == nil {
			t.Fatal("recover settled a grant that has no upstream write")
		}
		if !errors.Is(err, submit.ErrIllegalEdge) {
			t.Fatal(err)
		}
		if tr.writes.Load() != 0 {
			t.Fatal(tr.writes.Load())
		}
		if state := intentState(t, ctx, pool, first.IntentID); state != "submitting" {
			t.Fatal(state)
		}
	})

	if hits.Load() != 0 {
		t.Fatalf("loopback hits %d", hits.Load())
	}
}

type grantShop struct {
	t       *testing.T
	pool    *pgxpool.Pool
	org     int64
	user    int64
	storePK int64
	storeID string
	h       http.Handler
	opens   *atomic.Int32
}

func newGrantShop(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, user int64, ring seal.Ring, disabled bool, expires *int64) *grantShop {
	t.Helper()
	storePK, storeID := insertNextStore(t, ctx, pool, org)
	insertSealedCredential(t, ctx, pool, org, user, storePK, ring, expires)
	shop := &grantShop{t: t, pool: pool, org: org, user: user, storePK: storePK, storeID: storeID, opens: &atomic.Int32{}}
	shop.h = shop.handler(org, user, "owner", disabled)
	return shop
}

func (s *grantShop) handler(org, user int64, role string, disabled bool) http.Handler {
	router := chi.NewRouter()
	opens := s.opens
	kek := seal.DeriveKEK("browser-direct-fixture-kek")
	ring := seal.Ring{Primary: kek}
	srv := &httpapi.Server{
		Pool: s.pool,
		Access: access.FixedResolver{Principal: &access.Principal{
			UserID: user, OrgID: org, WorkspaceRole: role,
		}},
		Now:            time.Now,
		WritesDisabled: disabled,
		OpenGrant: func(env seal.Store) (seal.Secret, error) {
			opens.Add(1)
			return ring.OpenStore(env)
		},
	}
	httpapi.RegisterBrowserDirect(router, srv)
	return router
}

func (s *grantShop) row(t *testing.T, ctx context.Context) string {
	t.Helper()
	return insertFenceRow(t, ctx, s.pool, s.org, s.storeID)
}

func (s *grantShop) body(offer, op, row string) string {
	raw, err := json.Marshal(map[string]any{
		"storeId": s.storeID, "listingRowId": row, "rowRevision": 1,
		"clientOperationId": op, "requestHash": "hash-" + offer,
		"offerId": offer,
	})
	if err != nil {
		s.t.Fatal(err)
	}
	return string(raw)
}

func (s *grantShop) postGrant(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	return callJSON(s.h, http.MethodPost, "/api/listing/browser/grant", body)
}

func (s *grantShop) postReport(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	return callJSON(s.h, http.MethodPost, "/api/listing/browser/report", body)
}

func (s *grantShop) intentCount(t *testing.T, ctx context.Context) int {
	t.Helper()
	var n int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM public.submission_intents WHERE store_id = $1::uuid`, s.storeID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (s *grantShop) budgetCount(t *testing.T, ctx context.Context) int {
	t.Helper()
	var n int
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM public.lease_budget
		 WHERE namespace = $1 AND scope = $2`, sellerdomain.Namespace(), "browser-grant:"+s.storeID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func insertSealedCredential(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, user, storePK int64, ring seal.Ring, expires *int64) {
	t.Helper()
	env, err := seal.SealV1(ring.Primary, fixtureKeyID, fixtureClientID, fixtureAPIKey)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO public.store_seller_credentials (
			store_id, org_id, credential_revision, client_id, key_id, nonce, ciphertext,
			key_fingerprint, registered_by_user_id, registered_at_ms, envelope_version,
			key_expires_at_ms
		) VALUES (
			$1, $2, 1, $3, $4, $5, $6, $7, $8, 1, $9, $10
		)`, storePK, org, env.ClientID, env.KeyID, env.Nonce, env.Ciphertext, env.Fingerprint, user, env.Version, expires)
	if err != nil {
		t.Fatal(err)
	}
}

func farExpiry() *int64 {
	ms := time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	return &ms
}

type grantBody struct {
	IntentID string `json:"intentId"`
	State    string `json:"state"`
	ClientID string `json:"clientId"`
	APIKey   string `json:"apiKey"`
	Expires  int64  `json:"expiresAtMs"`
	TTL      int64  `json:"ttlMs"`
}

func parseGrant(t *testing.T, rec *httptest.ResponseRecorder) grantBody {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("grant %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Data grantBody `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body.Data
}

func assertNoKey(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status %d want %d body %s", rec.Code, status, rec.Body.String())
	}
	if strings.Count(rec.Body.String(), fixtureAPIKey) != 0 {
		t.Fatal(rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "Client-Id") || strings.Contains(rec.Body.String(), "Api-Key") {
		t.Fatal(rec.Body.String())
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Code != code {
		t.Fatalf("code %s want %s body %s", body.Code, code, rec.Body.String())
	}
}

func intentState(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string) string {
	t.Helper()
	var state string
	if err := pool.QueryRow(ctx, `SELECT state FROM public.submission_intents WHERE id = $1::uuid`, id).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func countJobs(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM public.jobs
		 WHERE org_id = $1 AND kind IN ('listing.submit', 'listing.submit.batch')`, org).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func countUpstream(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, intent string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM public.seller_upstream_writes
		 WHERE org_id = $1 AND idempotency_key = $2`, org, intent).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

type tallyTransport struct {
	writes atomic.Int32
}

func (t *tallyTransport) Write(context.Context, string, []byte) (int, string, error) {
	t.writes.Add(1)
	return http.StatusOK, "", nil
}

func (t *tallyTransport) Read(context.Context, string, []byte) (int, string, error) {
	t.writes.Add(1)
	return http.StatusOK, "", nil
}

func (t *tallyTransport) WritesDisabled() bool { return false }

func (t *tallyTransport) Ready(context.Context) error { return nil }
