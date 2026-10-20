package integration

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	"github.com/xxww0098/podhub-go/internal/app/worker"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/ozonerr/domain"
	ozonerrrepo "github.com/xxww0098/podhub-go/internal/ozonerr/repo"
	ozonerrsvc "github.com/xxww0098/podhub-go/internal/ozonerr/service"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestOzonErrorCatalogFollowup(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	userA, orgA := insertWorkspace(t, ctx, pool, "e3-a-"+uuid.NewString()+"@example.com", "E3 A")
	userB, orgB := insertWorkspace(t, ctx, pool, "e3-b-"+uuid.NewString()+"@example.com", "E3 B")
	run := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	if _, err := pool.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'podhub-login-test'`); err != nil {
		t.Fatal(err)
	}
	login, err := db.Connect(ctx, config.Config{DatabaseURL: swapUser(pool.Config().ConnString(), "podhub_login_api", "podhub-login-test")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(login.Close)
	svc := ozonerrsvc.New(ozonerrrepo.New(pool))
	loginSvc := ozonerrsvc.New(ozonerrrepo.New(login))
	t.Cleanup(func() {
		cctx := context.Background()
		_, _ = pool.Exec(cctx, `GRANT podhub_ozon_catalog TO podhub_login_api WITH INHERIT FALSE, SET TRUE`)
		_, _ = pool.Exec(cctx, `DELETE FROM public.ozon_error_catalog WHERE source <> 'docs_seed'`)
		_, _ = pool.Exec(cctx, `DELETE FROM public.organizations WHERE id IN ($1, $2)`, orgA, orgB)
		_, _ = pool.Exec(cctx, `DELETE FROM public.account_credentials WHERE user_id IN ($1, $2)`, userA, userB)
		_, _ = pool.Exec(cctx, `DELETE FROM public.account_profiles WHERE user_id IN ($1, $2)`, userA, userB)
		_, _ = pool.Exec(cctx, `DELETE FROM public.account_users WHERE id IN ($1, $2)`, userA, userB)
	})

	t.Run("migration grants the api login and not the worker role", func(t *testing.T) {
		assertRoleShape(t, ctx, pool, "podhub_ozon_catalog", false)
		assertRoleShape(t, ctx, pool, "podhub_ozon_sample_prune", false)
		assertRoleShape(t, ctx, pool, "podhub_login_api", true)
		if !hasRole(t, ctx, pool, "podhub_login_api", "podhub_ozon_catalog", "SET") {
			t.Fatal("00340 did not grant podhub_ozon_catalog to podhub_login_api")
		}
		if hasRole(t, ctx, pool, "podhub_login_api", "podhub_ozon_catalog", "USAGE") {
			t.Fatal("catalog membership is inherited")
		}
		if hasRole(t, ctx, pool, "podhub_worker", "podhub_ozon_catalog", "SET") || hasRole(t, ctx, pool, "podhub_worker", "podhub_ozon_sample_prune", "SET") {
			t.Fatal("worker role received a catalog grant")
		}
		for _, loginName := range []string{
			"podhub_login_api",
			"podhub_login_listing_worker",
			"podhub_login_ai_media_worker",
			"podhub_login_reconciler",
		} {
			if !hasRole(t, ctx, pool, loginName, "podhub_ozon_sample_prune", "SET") {
				t.Fatalf("%s cannot set podhub_ozon_sample_prune", loginName)
			}
			if hasRole(t, ctx, pool, loginName, "podhub_ozon_sample_prune", "USAGE") {
				t.Fatalf("%s inherits sample prune", loginName)
			}
		}
	})

	t.Run("login role fails closed then writes after the grant", func(t *testing.T) {
		if !hasRole(t, ctx, pool, "podhub_login_api", "podhub_ozon_catalog", "SET") {
			t.Fatal("00340 did not grant podhub_ozon_catalog to podhub_login_api")
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `GRANT podhub_ozon_catalog TO podhub_login_api WITH INHERIT FALSE, SET TRUE`)
		})
		if _, err := pool.Exec(ctx, `REVOKE podhub_ozon_catalog FROM podhub_login_api`); err != nil {
			t.Fatal(err)
		}
		kek := seal.DeriveKEK("browser-direct-fixture-kek")
		ring := seal.Ring{Primary: kek}
		shop := newOzonShop(t, ctx, pool, orgA, userA, ring, false, loginSvc)
		deniedID := parseGrant(t, shop.post(t, http.MethodPost, "/api/listing/browser/grant", shop.body("offer-e3-deny", "op-e3-deny", shop.row(t, ctx)))).IntentID
		logs := captureLog(t)
		rec := reportAs(login, loginSvc, orgA, userA, `{"intentId":"`+deniedID+`","httpStatus":409,"gateway":{"code":91005,"message":"denied `+fixtureAPIKey+`","details":[{"apiKey":"`+fixtureAPIKey+`"}]}}`)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"state":"rejected"`) {
			t.Fatalf("denied report %d %s", rec.Code, rec.Body.String())
		}
		assertListing(t, ctx, pool, deniedID, "rejected", "OZON_ACCESS_UNCLASSIFIED", "rejected")
		if n := sightingsFor(t, ctx, pool, orgA, "intent:"+deniedID); n != 0 {
			t.Fatalf("unauthorized sightings %d", n)
		}
		if catalogCount(t, ctx, pool, domain.SourceRequest, "91005") != 0 {
			t.Fatal("unauthorized global row")
		}
		if !strings.Contains(logs.String(), "ozon error catalog") {
			t.Fatalf("log %s", logs.String())
		}

		if _, err := pool.Exec(ctx, `GRANT podhub_ozon_catalog TO podhub_login_api WITH INHERIT FALSE, SET TRUE`); err != nil {
			t.Fatal(err)
		}
		allowedID := parseGrant(t, shop.post(t, http.MethodPost, "/api/listing/browser/grant", shop.body("offer-e3-ok", "op-e3-ok", shop.row(t, ctx)))).IntentID
		rec = reportAs(login, loginSvc, orgA, userA, `{"intentId":"`+allowedID+`","httpStatus":409,"gateway":{"code":91006,"message":"kept `+fixtureAPIKey+`"}}`)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"state":"rejected"`) {
			t.Fatalf("allowed report %d %s", rec.Code, rec.Body.String())
		}
		assertListing(t, ctx, pool, deniedID, "rejected", "OZON_ACCESS_UNCLASSIFIED", "rejected")
		assertListing(t, ctx, pool, allowedID, "rejected", "OZON_ACCESS_UNCLASSIFIED", "rejected")
		var sample, offer string
		if err := pool.QueryRow(ctx, `
			SELECT c.sample_description, s.offer_key
			  FROM public.ozon_error_sighting s
			  JOIN public.ozon_error_catalog c
			    ON c.source = s.source AND c.code = s.code
			   AND c.attribute_id = s.attribute_id
			   AND c.description_category_id = s.description_category_id
			   AND c.type_id = s.type_id
			 WHERE s.org_id = $1 AND s.task_key = $2`, orgA, "intent:"+allowedID).Scan(&sample, &offer); err != nil {
			t.Fatal(err)
		}
		if offer != "offer-e3-ok" || strings.Contains(sample, fixtureAPIKey) || !strings.Contains(sample, "[redacted]") {
			t.Fatalf("sample %q offer %q", sample, offer)
		}
		if catalogCount(t, ctx, pool, domain.SourceRequest, "91006") != 1 {
			t.Fatal("authorized write missing")
		}
	})

	t.Run("sample retention boundary", func(t *testing.T) {
		now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
		cutoff := domain.SampleCutoff(now)
		edge, old, fresh := "E3"+run+"EDGE", "E3"+run+"OLD", "E3"+run+"NEW"
		insertSample(t, ctx, pool, orgA, edge, "edge-sample", cutoff, 4)
		insertSample(t, ctx, pool, orgA, old, "old-sample", cutoff.Add(-time.Microsecond), 5)
		insertSample(t, ctx, pool, orgA, fresh, "fresh-sample", cutoff.Add(time.Hour), 6)
		var seedFirst, seedLast time.Time
		var seedSample string
		if err := pool.QueryRow(ctx, `
			SELECT first_seen_at, last_seen_at, sample_description
			  FROM public.ozon_error_catalog
			 WHERE source = 'docs_seed' AND code = 'Incorrect_density'`).Scan(&seedFirst, &seedLast, &seedSample); err != nil {
			t.Fatal(err)
		}
		aged := now.Add(-400 * 24 * time.Hour)
		if _, err := pool.Exec(ctx, `
			UPDATE public.ozon_error_catalog
			   SET first_seen_at = $1, last_seen_at = $1
			 WHERE source = 'docs_seed' AND code = 'Incorrect_density'`, aged); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `
				UPDATE public.ozon_error_catalog
				   SET first_seen_at = $1, last_seen_at = $2, sample_description = $3
				 WHERE source = 'docs_seed' AND code = 'Incorrect_density'`, seedFirst, seedLast, seedSample)
		})
		n, err := ozonerrrepo.New(login).ClearExpiredSamples(ctx, now)
		if err != nil {
			t.Fatal(err)
		}
		if n < 2 {
			t.Fatalf("blanked %d", n)
		}
		assertSample(t, ctx, pool, orgA, edge, "edge-sample", 4, cutoff)
		assertSample(t, ctx, pool, orgA, old, "", 5, cutoff.Add(-time.Microsecond))
		assertSample(t, ctx, pool, orgA, fresh, "fresh-sample", 6, cutoff.Add(time.Hour))
		var still string
		if err := pool.QueryRow(ctx, `
			SELECT sample_description FROM public.ozon_error_catalog
			 WHERE source = 'docs_seed' AND code = 'Incorrect_density'`).Scan(&still); err != nil || still != seedSample {
			t.Fatalf("seed sample %q %v", still, err)
		}
		tx, err := login.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_ozon_sample_prune', true)`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE public.ozon_error_catalog
			   SET occurrences = occurrences + 1
			 WHERE code = $1`, fresh); err == nil {
			t.Fatal("prune role updated occurrences")
		}

		riverCode := "E3" + run + "RIVER"
		insertSample(t, ctx, pool, orgA, riverCode, "river-sample", cutoff.Add(-time.Hour), 8)
		beforeJobs := countJobs(t, ctx, pool, orgA)
		if err := worker.RunErrorDigestHour(ctx, pool, now); err != nil {
			t.Fatal(err)
		}
		assertSample(t, ctx, pool, orgA, riverCode, "", 8, cutoff.Add(-time.Hour))
		assertSample(t, ctx, pool, orgA, edge, "edge-sample", 4, cutoff)
		if countJobs(t, ctx, pool, orgA) != beforeJobs {
			t.Fatal("digest hour wrote a job")
		}
	})

	t.Run("other 4xx and missing ids", func(t *testing.T) {
		req := []byte(`{"task_id":42201,"apiKey":"` + fixtureAPIKey + `","items":[{"offer_id":"not-stored"}]}`)
		resp := []byte(`{"message":"密度说明 ` + fixtureAPIKey + `","details":[{"apiKey":"` + fixtureAPIKey + `"}]}`)
		if err := svc.ObserveUpstream(ctx, orgA, 422, req, resp); err != nil {
			t.Fatal(err)
		}
		var sample string
		var attr, cat, typ int64
		if err := pool.QueryRow(ctx, `
			SELECT sample_description, attribute_id, description_category_id, type_id
			  FROM public.ozon_error_catalog
			 WHERE source = 'ozon_request' AND code = '422'`).Scan(&sample, &attr, &cat, &typ); err != nil {
			t.Fatal(err)
		}
		if attr != 0 || cat != 0 || typ != 0 || strings.Contains(sample, fixtureAPIKey) || strings.Contains(sample, "not-stored") || !strings.Contains(sample, "密度说明") || !strings.Contains(sample, "[redacted]") {
			t.Fatalf("sample %q ids %d %d %d", sample, attr, cat, typ)
		}
		if err := svc.ObserveUpstream(ctx, orgA, 422, []byte(`{"task_id":42202}`), []byte(`{"code":9,"message":"nine"}`)); err != nil {
			t.Fatal(err)
		}
		if catalogCount(t, ctx, pool, domain.SourceRequest, "9") != 1 || catalogCount(t, ctx, pool, domain.SourceRequest, "422") != 1 {
			t.Fatal("422 mapping changed an existing code or dropped the status")
		}
		beforeNine := catalogCount(t, ctx, pool, domain.SourceRequest, "9")
		beforeThree := catalogCount(t, ctx, pool, domain.SourceRequest, "3")
		if err := svc.ObserveUpstream(ctx, orgA, 400, []byte(`{"task_id":40001}`), []byte(`{"code":9,"message":"still three"}`)); err != nil {
			t.Fatal(err)
		}
		if catalogCount(t, ctx, pool, domain.SourceRequest, "9") != beforeNine {
			t.Fatal("400 with code 9 left the mapped code 3")
		}
		if catalogCount(t, ctx, pool, domain.SourceRequest, "3") != beforeThree+1 {
			t.Fatal("400 with code 9 was not stored as 3")
		}
		rows, err := domain.ParseImportBody([]byte(`{"taskId":3,"items":[{"errors":[{"code":"E3` + run + `Z","description":"缺省"}]}]}`))
		if err != nil {
			t.Fatal(err)
		}
		if n, err := svc.RecordRows(ctx, orgA, rows); err != nil || n != 1 {
			t.Fatal(n, err)
		}
		if err := pool.QueryRow(ctx, `
			SELECT attribute_id, description_category_id, type_id
			  FROM public.ozon_error_catalog
			 WHERE source = 'ozon_import_info' AND code = $1`, "E3"+run+"Z").Scan(&attr, &cat, &typ); err != nil || attr != 0 || cat != 0 || typ != 0 {
			t.Fatalf("stored ids %d %d %d %v", attr, cat, typ, err)
		}
	})

	t.Run("shared task id counts once", func(t *testing.T) {
		kek := seal.DeriveKEK("browser-direct-fixture-kek")
		ring := seal.Ring{Primary: kek}
		shop := newOzonShop(t, ctx, pool, orgA, userA, ring, false, svc)
		first := parseGrant(t, shop.post(t, http.MethodPost, "/api/listing/browser/grant", shop.body("offer-e3-same", "op-e3-same", shop.row(t, ctx)))).IntentID
		code := int64(91011)
		if err := svc.RecordRequest(ctx, orgA, domain.RequestError{
			IntentID: first, HTTPStatus: 409, GatewayCode: &code, Message: "once", TaskKey: "77011",
		}); err != nil {
			t.Fatal(err)
		}
		if err := svc.ObserveUpstream(ctx, orgA, 409, []byte(`{"task_id":77011,"apiKey":"`+fixtureAPIKey+`"}`), []byte(`{"code":91011,"message":"once","details":["`+fixtureAPIKey+`"]}`)); err != nil {
			t.Fatal(err)
		}
		assertOnce(t, ctx, pool, orgA, "77011", "91011")

		second := parseGrant(t, shop.post(t, http.MethodPost, "/api/listing/browser/grant", shop.body("offer-e3-rev", "op-e3-rev", shop.row(t, ctx)))).IntentID
		code = 91012
		if err := svc.ObserveUpstream(ctx, orgA, 409, []byte(`{"task_id":77012}`), []byte(`{"code":91012,"message":"rev"}`)); err != nil {
			t.Fatal(err)
		}
		if err := svc.RecordRequest(ctx, orgA, domain.RequestError{
			IntentID: second, HTTPStatus: 409, GatewayCode: &code, Message: "rev", TaskKey: "77012",
		}); err != nil {
			t.Fatal(err)
		}
		assertOnce(t, ctx, pool, orgA, "77012", "91012")

		third := parseGrant(t, shop.post(t, http.MethodPost, "/api/listing/browser/grant", shop.body("offer-e3-gap", "op-e3-gap", shop.row(t, ctx)))).IntentID
		code = 91013
		if err := svc.RecordRequest(ctx, orgA, domain.RequestError{
			IntentID: third, HTTPStatus: 409, GatewayCode: &code, Message: "gap",
		}); err != nil {
			t.Fatal(err)
		}
		if err := svc.ObserveUpstream(ctx, orgA, 409, []byte(`{"task_id":77013}`), []byte(`{"code":91013,"message":"gap"}`)); err != nil {
			t.Fatal(err)
		}
		if catalogCount(t, ctx, pool, domain.SourceRequest, "91013") != 2 {
			t.Fatal("report without a task id collapsed into the proxy row")
		}
		if err := svc.RecordRequest(ctx, orgA, domain.RequestError{
			IntentID: third, HTTPStatus: 409, GatewayCode: &code, Message: "gap", TaskKey: "77013",
		}); err != nil {
			t.Fatal(err)
		}
		if catalogCount(t, ctx, pool, domain.SourceRequest, "91013") != 2 {
			t.Fatal("shared key did not meet the proxy row")
		}
		var intentOffer string
		if err := pool.QueryRow(ctx, `
			SELECT offer_key FROM public.ozon_error_sighting
			 WHERE org_id = $1 AND task_key = $2`, orgA, "intent:"+third).Scan(&intentOffer); err != nil || intentOffer != "offer-e3-gap" {
			t.Fatalf("intent offer %q %v", intentOffer, err)
		}
	})
}

func assertRoleShape(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string, login bool) {
	t.Helper()
	var super, bypass, canLogin bool
	err := pool.QueryRow(ctx, `
		SELECT rolsuper, rolbypassrls, rolcanlogin
		  FROM pg_roles WHERE rolname = $1`, name).Scan(&super, &bypass, &canLogin)
	if err != nil || super || bypass || canLogin != login {
		t.Fatalf("%s super %v bypass %v login %v err %v", name, super, bypass, canLogin, err)
	}
}

func hasRole(t *testing.T, ctx context.Context, pool *pgxpool.Pool, member, role, privilege string) bool {
	t.Helper()
	var ok bool
	if err := pool.QueryRow(ctx, `SELECT pg_has_role($1, $2, $3)`, member, role, privilege).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	return ok
}

func reportAs(pool *pgxpool.Pool, ozon httpapi.OzonRecorder, org, user int64, body string) *httptest.ResponseRecorder {
	router := chi.NewRouter()
	srv := &httpapi.Server{
		Pool: pool,
		Access: access.FixedResolver{Principal: &access.Principal{
			UserID: user, OrgID: org, WorkspaceRole: "owner",
		}},
		Now:  time.Now,
		Ozon: ozon,
	}
	httpapi.RegisterBrowserDirect(router, srv)
	return callJSON(router, http.MethodPost, "/api/listing/browser/report", body)
}

func assertListing(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id, state, code, row string) {
	t.Helper()
	var gotState, gotCode, gotRow string
	if err := pool.QueryRow(ctx, `
		SELECT i.state, COALESCE(i.last_error_code, ''), r.submission_state
		  FROM public.submission_intents i
		  JOIN public.listing_rows r ON r.id = i.listing_row_id
		 WHERE i.id = $1::uuid`, id).Scan(&gotState, &gotCode, &gotRow); err != nil {
		t.Fatal(err)
	}
	if gotState != state || gotCode != code || gotRow != row {
		t.Fatalf("listing %s %s %s", gotState, gotCode, gotRow)
	}
}

func sightingsFor(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, taskKey string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM public.ozon_error_sighting
		 WHERE org_id = $1 AND task_key = $2`, org, taskKey).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func insertSample(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, code, sample string, at time.Time, occ int64) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.ozon_error_catalog (
			source, code, attribute_id, description_category_id, type_id,
			sample_description, occurrences, first_seen_at, last_seen_at)
		VALUES ('ozon_request', $1, 0, 0, 0, $2, $3, $4, $4)`, code, sample, occ, at); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.ozon_error_observation (
			org_id, source, code, attribute_id, description_category_id, type_id,
			sample_description, occurrences, first_seen_at, last_seen_at)
		VALUES ($1, 'ozon_request', $2, 0, 0, 0, $3, $4, $5, $5)`, org, code, sample, occ, at); err != nil {
		t.Fatal(err)
	}
}

func assertSample(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, code, sample string, occ int64, at time.Time) {
	t.Helper()
	var got string
	var gotOcc int64
	var first, last time.Time
	if err := pool.QueryRow(ctx, `
		SELECT sample_description, occurrences, first_seen_at, last_seen_at
		  FROM public.ozon_error_catalog
		 WHERE source = 'ozon_request' AND code = $1`, code).Scan(&got, &gotOcc, &first, &last); err != nil {
		t.Fatal(err)
	}
	if got != sample || gotOcc != occ || !first.Equal(at) || !last.Equal(at) {
		t.Fatalf("catalog %s sample %q occ %d first %s last %s", code, got, gotOcc, first, last)
	}
	if err := pool.QueryRow(ctx, `
		SELECT sample_description, occurrences, first_seen_at, last_seen_at
		  FROM public.ozon_error_observation
		 WHERE org_id = $1 AND source = 'ozon_request' AND code = $2`, org, code).Scan(&got, &gotOcc, &first, &last); err != nil {
		t.Fatal(err)
	}
	if got != sample || gotOcc != occ || !first.Equal(at) || !last.Equal(at) {
		t.Fatalf("observation %s sample %q occ %d first %s last %s", code, got, gotOcc, first, last)
	}
}

func assertOnce(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, taskKey, code string) {
	t.Helper()
	var n int
	var offer, sample string
	if err := pool.QueryRow(ctx, `
		SELECT count(*), coalesce(max(offer_key), '')
		  FROM public.ozon_error_sighting
		 WHERE org_id = $1 AND task_key = $2 AND code = $3`, org, taskKey, code).Scan(&n, &offer); err != nil {
		t.Fatal(err)
	}
	if n != 1 || offer != "" {
		t.Fatalf("sightings %d offer %q", n, offer)
	}
	if err := pool.QueryRow(ctx, `
		SELECT sample_description FROM public.ozon_error_catalog
		 WHERE source = 'ozon_request' AND code = $1`, code).Scan(&sample); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(sample, fixtureAPIKey) {
		t.Fatal(sample)
	}
	if catalogCount(t, ctx, pool, domain.SourceRequest, code) != 1 {
		t.Fatal(code)
	}
}

type logBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *logBuf) Enabled(context.Context, slog.Level) bool { return true }
func (l *logBuf) Handle(_ context.Context, r slog.Record) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.b.WriteString(r.Message)
	r.Attrs(func(a slog.Attr) bool {
		l.b.WriteByte(' ')
		l.b.WriteString(a.String())
		return true
	})
	l.b.WriteByte('\n')
	return nil
}
func (l *logBuf) WithAttrs([]slog.Attr) slog.Handler { return l }
func (l *logBuf) WithGroup(string) slog.Handler      { return l }
func (l *logBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func captureLog(t *testing.T) *logBuf {
	t.Helper()
	buf := &logBuf{}
	prev := slog.Default()
	slog.SetDefault(slog.New(buf))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf
}
