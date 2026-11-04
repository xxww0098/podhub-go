package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/ai"
	"github.com/xxww0098/podhub-go/internal/app"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	identitysvc "github.com/xxww0098/podhub-go/internal/identity"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	registry "github.com/xxww0098/podhub-go/internal/media/service/registry"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// The provider is deliberately a substitute. With PODHUB_AI_IMAGE_EVIDENCE_DIR
// it replays the three previously generated real files, without a paid call.
type recordedImageGenerator struct {
	mu      sync.Mutex
	images  [][]byte
	calls   int
	failAt  int
	unknown bool
	gate    chan struct{}
	started chan struct{}
	delay   time.Duration
}

func (g *recordedImageGenerator) Generate(ctx context.Context, _ []byte, _ string) ([]byte, error) {
	g.mu.Lock()
	g.calls++
	call := g.calls
	g.mu.Unlock()
	if g.started != nil {
		select {
		case g.started <- struct{}{}:
		default:
		}
	}
	if g.gate != nil {
		select {
		case <-g.gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if g.delay > 0 && call == 1 {
		timer := time.NewTimer(g.delay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if g.failAt == call {
		return nil, &ai.ImageProviderError{Class: "image_test_failure", Unknown: g.unknown}
	}
	return g.images[(call-1)%3], nil
}
func (g *recordedImageGenerator) count() int { g.mu.Lock(); defer g.mu.Unlock(); return g.calls }

type imageTestBucket struct {
	mu         sync.Mutex
	bodies     map[string][]byte
	puts       int
	corrupt    bool
	publicFail bool
}

func (b *imageTestBucket) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if r.Host == "pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev" && b.publicFail {
		w.WriteHeader(403)
		return
	}
	switch r.Method {
	case http.MethodPut:
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 21<<20))
		sum := sha256.Sum256(raw)
		if r.Header.Get("X-Amz-Checksum-Sha256") != base64.StdEncoding.EncodeToString(sum[:]) {
			http.Error(w, "checksum", 400)
			return
		}
		if _, exists := b.bodies[r.URL.Path]; exists {
			w.WriteHeader(412)
			return
		}
		b.bodies[r.URL.Path] = append([]byte(nil), raw...)
		b.puts++
		w.WriteHeader(200)
	case http.MethodHead, http.MethodGet:
		raw, ok := b.bodies[r.URL.Path]
		if !ok {
			w.WriteHeader(404)
			return
		}
		sum := sha256.Sum256(raw)
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
		w.Header().Set("X-Amz-Checksum-Sha256", base64.StdEncoding.EncodeToString(sum[:]))
		if r.Method == http.MethodGet {
			if b.corrupt {
				raw = append([]byte(nil), raw...)
				raw[0] ^= 1
			}
			_, _ = w.Write(raw)
		}
	default:
		w.WriteHeader(405)
	}
}

func imageEvidence(t *testing.T) ([]byte, [][]byte) {
	t.Helper()
	if dir := os.Getenv("PODHUB_AI_IMAGE_EVIDENCE_DIR"); dir != "" {
		source, err := os.ReadFile(filepath.Join(dir, "source-product-tote.jpg"))
		if err != nil {
			t.Fatal(err)
		}
		var out [][]byte
		for i := 1; i <= 3; i++ {
			raw, e := os.ReadFile(filepath.Join(dir, fmt.Sprintf("set-%d.png", i)))
			if e != nil {
				t.Fatal(e)
			}
			out = append(out, raw)
		}
		t.Log("Replaying real provider evidence through a substitute; no external inference or production bucket call.")
		return source, out
	}
	var out [][]byte
	for i := 0; i < 3; i++ {
		img := image.NewRGBA(image.Rect(0, 0, 1024, 1024))
		for y := 0; y < 1024; y++ {
			for x := 0; x < 1024; x++ {
				img.SetRGBA(x, y, color.RGBA{R: uint8(30 + i*40), G: uint8(x % 256), B: uint8(y % 256), A: 255})
			}
		}
		var buf bytes.Buffer
		_ = png.Encode(&buf, img)
		out = append(out, buf.Bytes())
	}
	return out[0], out
}

func TestAIImageSetsNormalAPI(t *testing.T) {

	var passedCases []string
	run := func(name string, fn func(*testing.T)) {
		executed := false
		passed := t.Run(name, func(t *testing.T) { executed = true; fn(t) })
		if executed && passed {
			passedCases = append(passedCases, name)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	dsn := securityDSN(t, ctx)
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	pool, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err = db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'image-test-login'`); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	apiPool, err := db.Connect(ctx, config.Config{DatabaseURL: swapUser(dsn, "podhub_login_api", "image-test-login")})
	if err != nil {
		t.Fatal(err)
	}
	defer apiPool.Close()
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	t.Setenv("CLOUD_COOKIE_SECURE", "0")
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "parity-test-key")
	if _, err := pool.Exec(ctx, `INSERT INTO account_users(public_id,email,password_hash,role,name,target,supplier_id,plan,created_at,updated_at) VALUES('00000000-0000-4000-8000-000000009991','image-owner@example.invalid','x','super_admin','Owner','/workspace','','free',clock_timestamp(),clock_timestamp()); UPDATE platform_initialization SET owner_account_id=(SELECT id FROM account_users WHERE email='image-owner@example.invalid'),initialized_at=clock_timestamp() WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	appHandler := app.Handler(pool)
	register := func(email, key string) (string, int64, int64) {
		rec := postJSON(t, appHandler, "/api/auth/register", `{"email":"`+email+`","password":"correct-horse","name":"Image"}`, key, "")
		if rec.Code != 200 {
			t.Fatalf("register %d %s", rec.Code, rec.Body.String())
		}
		var org, user int64
		if err := pool.QueryRow(ctx, `SELECT o.id,u.id FROM organizations o JOIN account_users u ON o.owner_user_id=u.id WHERE u.email=$1`, email).Scan(&org, &user); err != nil {
			t.Fatal(err)
		}
		return sessionCookie(rec), org, user
	}
	cookie, org, user := register("image-a@example.invalid", "image-reg-a")
	run("normal login role and original session query", func(t *testing.T) {
		var role string
		var privileged bool
		if err := apiPool.QueryRow(ctx, `SELECT current_user,rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user`).Scan(&role, &privileged); err != nil || role != "podhub_login_api" || privileged {
			t.Fatalf("API role %s privileged=%v err=%v", role, privileged, err)
		}
		rows, err := pool.Query(ctx, `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN('account_sessions','account_users','account_profiles','organization_members','organizations') ORDER BY relname`)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var name string
			var enabled, forced bool
			if err = rows.Scan(&name, &enabled, &forced); err != nil {
				t.Fatal(err)
			}
			t.Logf("identity table=%s rls=%v forced=%v", name, enabled, forced)
		}
		rows.Close()
		token := strings.TrimPrefix(strings.Split(cookie, ";")[0], "sid=")
		err = db.InTx(ctx, apiPool, db.Staff(), func(tx pgx.Tx) error {
			row, e := sqlc.New(tx).ResolveAccount(ctx, sha256Hex(token))
			if e == nil && (row.ID != user || row.OrgID != org) {
				return fmt.Errorf("session query identity mismatch")
			}
			return e
		})
		if err != nil {
			t.Fatalf("ResolveAccount under staff role: %v", err)
		}
	})

	otherCookie, otherOrg, _ := register("image-b@example.invalid", "image-reg-b")
	seedMatchingLease(t, ctx, pool, "billing", "image sets")
	if _, err := billingrepo.Adjust(ctx, pool, org, "image-seed", 10_000_000, "seed"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO ai_price_schedules(model,billing_mode,input_microfen_per_million,cached_input_microfen_per_million,output_microfen_per_million,reasoning_microfen_per_million,per_request_microfen,max_request_microfen,effective_from) VALUES('qwen-image-2.1-pro','per_request',0,0,0,0,250000,250000,clock_timestamp())`); err != nil {
		t.Fatal(err)
	}
	source, outputs := imageEvidence(t)
	bucket := &imageTestBucket{bodies: map[string][]byte{}}
	server := httptest.NewServer(bucket)
	defer server.Close()
	account := registry.Account{ID: "image-test", Provider: "cloudflare", Endpoint: server.URL, Region: "auto", Bucket: "podhub-test-supplier", PublicBaseURL: "https://pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev", ForcePathStyle: true, AccessKeyID: "test", SecretAccessKey: "test"}
	localURL, _ := url.Parse(server.URL)
	client := server.Client()
	transport := client.Transport
	client.Transport = imageRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev" {
			copy := r.Clone(r.Context())
			target := *r.URL
			target.Scheme = localURL.Scheme
			target.Host = localURL.Host
			target.Path = "/podhub-test-supplier" + target.Path
			copy.URL = &target
			copy.Host = "pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev"
			return transport.RoundTrip(copy)
		}
		return transport.RoundTrip(r)
	})
	assets := app.NewRegistryImageAssets(apiPool, account, client)
	generator := &recordedImageGenerator{images: outputs}
	resolver := func(context.Context, string, string) (ai.ImageGenerator, ai.ImageAssets, error) {
		return generator, assets, nil
	}
	storageIdentity, err := (media.Config{Endpoint: account.Endpoint, Bucket: account.Bucket, KeyPrefix: account.KeyPrefix}).Identity()
	if err != nil {
		t.Fatal(err)
	}
	publicURL := func(_ context.Context, bucketIdentity, key string) (string, error) {
		if bucketIdentity != storageIdentity {
			return "", errors.New("image bucket changed")
		}
		return account.PublicURL(key), nil
	}
	makeHandler := func(runtime *ai.ImageRuntime) http.Handler {
		if runtime != nil && runtime.PublicURL == nil {
			runtime.PublicURL = publicURL
		}
		svc := identitysvc.New(apiPool)
		r := chi.NewRouter()
		r.Use(identitysvc.CSRF)
		r.Use(svc.Middleware)
		ai.Register(r, ai.HTTPDeps{Deps: ai.Deps{Pool: apiPool, Wallet: aiWalletPort(), Images: runtime}, Access: svc})
		return r
	}
	handler := makeHandler(&ai.ImageRuntime{Resolve: resolver})
	body, _ := json.Marshal(map[string]any{"account_id": "image-account", "model": "qwen-image-2.1-pro", "source_base64": base64.StdEncoding.EncodeToString(source), "expected_unit_microfen": int64(250000)})
	request := func(h http.Handler, method, path, key, cookie string, body []byte, requestContext context.Context) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		if requestContext != nil {
			req = req.WithContext(requestContext)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("Cookie", cookie)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	parse := func(rec *httptest.ResponseRecorder) ai.ImageSetView {
		t.Helper()
		if rec.Code != 200 && rec.Code != 202 {
			t.Fatalf("response %d %s", rec.Code, rec.Body.String())
		}
		var v ai.ImageSetView
		if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	assertWallet := func() {
		t.Helper()
		var held int64
		if err := pool.QueryRow(ctx, `SELECT held_microfen FROM workspace_wallets WHERE org_id=$1`, org).Scan(&held); err != nil || held != 0 {
			t.Fatalf("wallet hold %d %v", held, err)
		}
		mismatches, err := billingrepo.CheckInvariant(ctx, pool)
		if err != nil || len(mismatches) != 0 {
			t.Fatalf("wallet invariant %+v %v", mismatches, err)
		}
	}
	run("authentication and preflight", func(t *testing.T) {
		if rec := request(handler, "POST", "/api/ai/image-sets", "anon", "", body, nil); rec.Code != 401 {
			t.Fatalf("anonymous %d", rec.Code)
		}
		if rec := request(makeHandler(nil), "POST", "/api/ai/image-sets", "unconfigured", cookie, body, nil); rec.Code != 503 {
			t.Fatalf("unconfigured %d %s", rec.Code, rec.Body.String())
		}
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM ai_requests WHERE operation='image'`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("preflight wrote %d %v", count, err)
		}
	})
	var ready ai.ImageSetView
	run("three real output bytes saved charged read and replayed", func(t *testing.T) {
		ready = parse(request(handler, "POST", "/api/ai/image-sets", "ready", cookie, body, nil))
		if ready.Status != "ready" || generator.count() != 3 {
			t.Fatalf("result %+v calls %d", ready, generator.count())
		}
		var charged int64
		for _, item := range ready.Items {
			if item.Asset == nil || !strings.HasPrefix(item.Asset.URL, account.PublicBaseURL+"/") || !strings.Contains(item.Asset.URL, fmt.Sprintf("/orgs/%d/images/", org)) {
				t.Fatalf("asset %+v", item)
			}
			charged += item.Charged
		}
		if charged != 750000 {
			t.Fatalf("charge %d", charged)
		}
		read := parse(request(handler, "GET", "/api/ai/image-sets/"+ready.ID, "", cookie, nil, nil))
		if read.Status != "ready" {
			t.Fatalf("read %+v", read)
		}
		recovered := parse(request(handler, "GET", "/api/ai/image-sets", "ready", cookie, nil, nil))
		if recovered.ID != ready.ID || generator.count() != 3 {
			t.Fatal("key lookup lost the request or repeated inference")
		}
		for _, test := range []struct{ key, cookie string }{{"ready", otherCookie}, {"not-created", cookie}} {
			if rec := request(handler, "GET", "/api/ai/image-sets", test.key, test.cookie, nil, nil); rec.Code != 404 {
				t.Fatalf("tenant or missing key lookup %d", rec.Code)
			}
		}
		replay := parse(request(handler, "POST", "/api/ai/image-sets", "ready", cookie, body, nil))
		if replay.ID != ready.ID || generator.count() != 3 {
			t.Fatal("replay generated again")
		}
		other := request(handler, "GET", "/api/ai/image-sets/"+ready.ID, "", otherCookie, nil, nil)
		if other.Code != 404 {
			t.Fatalf("cross tenant %d", other.Code)
		}
		var refs int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM storage_object_refs WHERE owner_org_id=$1 AND owner_kind IN('ai_image_set','ai_image_item')`, org).Scan(&refs); err != nil || refs != 4 {
			t.Fatalf("refs %d %v", refs, err)
		}
		assertWallet()
	})
	run("existing results need storage but no active model", func(t *testing.T) {
		readOnly := makeHandler(&ai.ImageRuntime{PublicURL: publicURL})
		for _, input := range []struct {
			method, path, key string
			body              []byte
		}{
			{"GET", "/api/ai/image-sets/" + ready.ID, "", nil},
			{"GET", "/api/ai/image-sets", "ready", nil},
			{"POST", "/api/ai/image-sets", "ready", body},
		} {
			view := parse(request(readOnly, input.method, input.path, input.key, cookie, input.body, nil))
			if view.Status != "ready" || view.Items[0].Asset.URL != ready.Items[0].Asset.URL || generator.count() != 3 {
				t.Fatal("stored image URL changed or inference repeated")
			}
		}
		oneConfig, err := pgxpool.ParseConfig(swapUser(dsn, "podhub_login_api", "image-test-login"))
		if err != nil {
			t.Fatal(err)
		}
		oneConfig.MaxConns = 1
		one, err := pgxpool.NewWithConfig(ctx, oneConfig)
		if err != nil {
			t.Fatal(err)
		}
		defer one.Close()
		oneSession := identitysvc.New(one)
		oneRouter := chi.NewRouter()
		oneRouter.Use(identitysvc.CSRF)
		oneRouter.Use(oneSession.Middleware)
		ai.Register(oneRouter, ai.HTTPDeps{Deps: ai.Deps{Pool: one, Wallet: aiWalletPort(), Images: &ai.ImageRuntime{PublicURL: func(ctx context.Context, identity, key string) (string, error) {
			bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			var value int
			if err := one.QueryRow(bounded, `SELECT 1`).Scan(&value); err != nil {
				return "", err
			}
			return publicURL(ctx, identity, key)
		}}}, Access: oneSession})
		if rec := request(oneRouter, "GET", "/api/ai/image-sets/"+ready.ID, "", cookie, nil, nil); rec.Code != http.StatusOK {
			t.Fatalf("single connection could not resolve stored image: %d", rec.Code)
		}
		changed := makeHandler(&ai.ImageRuntime{PublicURL: func(_ context.Context, storedIdentity, key string) (string, error) {
			if storedIdentity != storageIdentity {
				t.Fatal("task read did not supply stored bucket identity")
			}
			return "", errors.New("bucket changed")
		}})
		rec := request(changed, "GET", "/api/ai/image-sets/"+ready.ID, "", cookie, nil, nil)
		if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), account.PublicBaseURL) {
			t.Fatal("old bucket object was exposed through changed configuration")
		}
	})
	run("same key changed input conflicts", func(t *testing.T) {
		var changed map[string]any
		_ = json.Unmarshal(body, &changed)
		changed["account_id"] = "changed"
		raw, _ := json.Marshal(changed)
		rec := request(handler, "POST", "/api/ai/image-sets", "ready", cookie, raw, nil)
		if rec.Code != 409 || generator.count() != 3 {
			t.Fatalf("conflict %d calls %d", rec.Code, generator.count())
		}
		changed["account_id"] = "image-account"
		changed["expected_unit_microfen"] = int64(500000)
		raw, _ = json.Marshal(changed)
		rec = request(handler, "POST", "/api/ai/image-sets", "ready", cookie, raw, nil)
		if rec.Code != 409 || !strings.Contains(rec.Body.String(), "IDEMPOTENCY_CONFLICT") || generator.count() != 3 {
			t.Fatalf("confirmed price input was not bound to key: HTTP %d", rec.Code)
		}
	})
	run("partial failure retains first asset without repeated calls", func(t *testing.T) {
		generator = &recordedImageGenerator{images: outputs, failAt: 2, unknown: true}
		partial := parse(request(handler, "POST", "/api/ai/image-sets", "partial", cookie, body, nil))
		if partial.Status != "partial" || partial.Items[0].Asset == nil || partial.Items[1].Asset != nil || generator.count() != 2 {
			t.Fatalf("partial %+v calls %d", partial, generator.count())
		}
		_ = parse(request(handler, "POST", "/api/ai/image-sets", "partial", cookie, body, nil))
		if generator.count() != 2 {
			t.Fatal("unknown result retried")
		}
		assertWallet()
	})
	run("insufficient funds rollback all holds", func(t *testing.T) {
		calls := generator.count()
		rec := request(handler, "POST", "/api/ai/image-sets", "no-funds", otherCookie, body, nil)
		if rec.Code != 402 || generator.count() != calls {
			t.Fatalf("funds %d %s", rec.Code, rec.Body.String())
		}
		var count int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM ai_image_sets WHERE org_id=$1`, otherOrg).Scan(&count)
		if count != 0 {
			t.Fatal("failed hold left group")
		}
		assertWallet()
	})
	run("cancel dispatched unknown without retry", func(t *testing.T) {
		generator = &recordedImageGenerator{images: outputs, gate: make(chan struct{}), started: make(chan struct{}, 1)}
		cancelCtx, stop := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() {
			defer close(done)
			_ = request(handler, "POST", "/api/ai/image-sets", "cancel", cookie, body, cancelCtx)
		}()
		<-generator.started
		stop()
		<-done
		replay := parse(request(handler, "POST", "/api/ai/image-sets", "cancel", cookie, body, nil))
		if replay.Status != "unknown" || generator.count() != 1 {
			t.Fatalf("cancel %+v calls %d", replay, generator.count())
		}
		assertWallet()
	})
	run("concurrent identical key only one group and three calls", func(t *testing.T) {
		generator = &recordedImageGenerator{images: outputs, gate: make(chan struct{}), started: make(chan struct{}, 1)}
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { done <- request(handler, "POST", "/api/ai/image-sets", "parallel", cookie, body, nil) }()
		<-generator.started
		concurrent := parse(request(handler, "POST", "/api/ai/image-sets", "parallel", cookie, body, nil))
		if concurrent.Status != "processing" {
			t.Fatalf("concurrent %+v", concurrent)
		}
		close(generator.gate)
		finished := parse(<-done)
		if finished.ID != concurrent.ID || finished.Status != "ready" || generator.count() != 3 {
			t.Fatalf("concurrent end %+v calls %d", finished, generator.count())
		}
		assertWallet()
	})
	run("readback corruption cannot become ready or charged", func(t *testing.T) {
		generator = &recordedImageGenerator{images: outputs}
		bucket.mu.Lock()
		bucket.corrupt = true
		bucket.mu.Unlock()
		result := parse(request(handler, "POST", "/api/ai/image-sets", "bad-storage", cookie, body, nil))
		if result.Status != "failed" || generator.count() != 0 {
			t.Fatalf("corrupt source %+v calls %d", result, generator.count())
		}
		bucket.mu.Lock()
		bucket.corrupt = false
		bucket.mu.Unlock()
		assertWallet()
	})

	run("changed confirmed price refuses holds and inference", func(t *testing.T) {
		before := generator.count()
		var requestsBefore int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM ai_requests WHERE operation='image'`).Scan(&requestsBefore); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE ai_price_schedules SET per_request_microfen=500000,max_request_microfen=500000 WHERE model='qwen-image-2.1-pro'`); err != nil {
			t.Fatal(err)
		}
		defer pool.Exec(ctx, `UPDATE ai_price_schedules SET per_request_microfen=250000,max_request_microfen=250000 WHERE model='qwen-image-2.1-pro'`)
		rec := request(handler, "POST", "/api/ai/image-sets", "stale-price", cookie, body, nil)
		var after int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM ai_requests WHERE operation='image'`).Scan(&after); err != nil {
			t.Fatal(err)
		}
		if rec.Code != 409 || !strings.Contains(rec.Body.String(), "IMAGE_PRICE_CHANGED") || generator.count() != before || after != requestsBefore {
			t.Fatalf("price changed HTTP %d calls %d requests %d/%d", rec.Code, generator.count(), requestsBefore, after)
		}
		assertWallet()
	})
	run("authority lost during source storage prevents inference", func(t *testing.T) {
		generator = &recordedImageGenerator{images: outputs}
		revokingAssets := imageAssetsFunc(func(ctx context.Context, org, user int64, source []byte) (ai.ImageAsset, error) {
			asset, err := assets.Save(ctx, org, user, source)
			if err == nil {
				_, err = pool.Exec(ctx, `UPDATE writer_leases SET heartbeat_at_ms=0,expires_at_ms=1 WHERE domain='billing' AND revoked_at_ms IS NULL`)
			}
			return asset, err
		})
		revokingHandler := makeHandler(&ai.ImageRuntime{Resolve: func(context.Context, string, string) (ai.ImageGenerator, ai.ImageAssets, error) {
			return generator, revokingAssets, nil
		}})
		defer seedMatchingLease(t, ctx, pool, "billing", "restore source storage test authority")
		result := parse(request(revokingHandler, "POST", "/api/ai/image-sets", "source-authority-lost", cookie, body, nil))
		var dispatched int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM ai_requests r JOIN ai_image_set_items i ON i.request_id=r.id WHERE i.set_id=$1::uuid AND r.dispatched_at IS NOT NULL`, result.ID).Scan(&dispatched); err != nil {
			t.Fatal(err)
		}
		seedMatchingLease(t, ctx, pool, "billing", "recover source storage test holds")
		if _, err := pool.Exec(ctx, `UPDATE ai_requests SET updated_at=clock_timestamp()-interval '6 minutes' WHERE id IN(SELECT request_id FROM ai_image_set_items WHERE set_id=$1::uuid)`, result.ID); err != nil {
			t.Fatal(err)
		}
		_ = parse(request(handler, "GET", "/api/ai/image-sets/"+result.ID, "", cookie, nil, nil))
		assertWallet()
		if generator.count() != 0 || dispatched != 0 {
			t.Fatalf("lost billing authority still dispatched=%d provider calls=%d", dispatched, generator.count())
		}
	})
	run("unpublished image price fails before any holds or generation", func(t *testing.T) {
		before := generator.count()
		var count int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM ai_requests WHERE operation='image'`).Scan(&count)
		if _, err := pool.Exec(ctx, `UPDATE ai_price_schedules SET effective_from=clock_timestamp()+interval '1 day' WHERE model='qwen-image-2.1-pro'`); err != nil {
			t.Fatal(err)
		}
		defer pool.Exec(ctx, `UPDATE ai_price_schedules SET effective_from=clock_timestamp() WHERE model='qwen-image-2.1-pro'`)
		rec := request(handler, "POST", "/api/ai/image-sets", "no-price", cookie, body, nil)
		var after int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM ai_requests WHERE operation='image'`).Scan(&after)
		if rec.Code != 503 || generator.count() != before || count != after {
			t.Fatalf("price preflight %d calls %d requests %d/%d", rec.Code, generator.count(), count, after)
		}
		assertWallet()
	})
	run("public access failure cannot become ready", func(t *testing.T) {
		generator = &recordedImageGenerator{images: outputs}
		bucket.mu.Lock()
		bucket.publicFail = true
		bucket.mu.Unlock()
		defer func() { bucket.mu.Lock(); bucket.publicFail = false; bucket.mu.Unlock() }()
		result := parse(request(handler, "POST", "/api/ai/image-sets", "private-only", cookie, body, nil))
		if result.Status != "failed" || generator.count() != 0 {
			t.Fatalf("public access %+v calls %d", result, generator.count())
		}
		assertWallet()
	})
	run("asset pin failure rolls back charge and request settlement", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `CREATE FUNCTION public.image_test_reject_pin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test pin refusal'; END $$; CREATE TRIGGER image_test_pin BEFORE UPDATE OF object_id ON public.ai_image_set_items FOR EACH ROW EXECUTE FUNCTION public.image_test_reject_pin()`); err != nil {
			t.Fatal(err)
		}
		defer pool.Exec(ctx, `DROP TRIGGER image_test_pin ON public.ai_image_set_items; DROP FUNCTION public.image_test_reject_pin()`)
		generator = &recordedImageGenerator{images: outputs}
		result := parse(request(handler, "POST", "/api/ai/image-sets", "pin-rollback", cookie, body, nil))
		if result.Status != "unknown" || generator.count() != 1 {
			t.Fatalf("pin rollback %+v calls %d", result, generator.count())
		}
		for _, item := range result.Items {
			if item.Asset != nil || item.Charged != 0 {
				t.Fatalf("pin committed %+v", item)
			}
		}
		var charged, logs int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM ai_requests r JOIN ai_image_set_items i ON i.request_id=r.id WHERE i.set_id=$1::uuid AND (r.status='settled' OR r.total_microfen<>0)`, result.ID).Scan(&charged)
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM ai_consume_logs l JOIN ai_image_set_items i ON i.request_id=l.ai_request_id WHERE i.set_id=$1::uuid`, result.ID).Scan(&logs)
		if charged != 0 || logs != 0 {
			t.Fatalf("settlement/log committed %d/%d", charged, logs)
		}
		assertWallet()
	})
	run("stale unknown hold waits for authority then recovers without generation", func(t *testing.T) {
		generator = &recordedImageGenerator{images: outputs}
		var requestID int64
		var publicID string
		if err := pool.QueryRow(ctx, `SELECT i.request_id,r.public_id FROM ai_image_set_items i JOIN ai_requests r ON r.id=i.request_id WHERE i.set_id=$1::uuid AND i.ordinal=0`, ready.ID).Scan(&requestID, &publicID); err != nil {
			t.Fatal(err)
		}
		// Create a separate authentic reservation through a real wallet transaction,
		// then backdate only the request to represent an interrupted process.
		var recoveredID string
		generator = &recordedImageGenerator{images: outputs, gate: make(chan struct{}), started: make(chan struct{}, 1)}
		cancelled, stop := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() {
			defer close(done)
			_ = request(handler, "POST", "/api/ai/image-sets", "recover", cookie, body, cancelled)
		}()
		<-generator.started
		// Explicitly revoke authority before cancellation; cleanup is forbidden.
		if _, err := pool.Exec(ctx, `UPDATE writer_leases SET heartbeat_at_ms=0,expires_at_ms=1 WHERE domain='billing' AND revoked_at_ms IS NULL`); err != nil {
			t.Fatal(err)
		}
		stop()
		<-done
		if err := pool.QueryRow(ctx, `SELECT id::text FROM ai_image_sets WHERE org_id=$1 AND idempotency_key='recover'`, org).Scan(&recoveredID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE ai_requests SET updated_at=clock_timestamp()-interval '6 minutes' WHERE id IN(SELECT request_id FROM ai_image_set_items WHERE set_id=$1::uuid)`, recoveredID); err != nil {
			t.Fatal(err)
		}
		unknown := parse(request(handler, "GET", "/api/ai/image-sets/"+recoveredID, "", cookie, nil, nil))
		var held int64
		_ = pool.QueryRow(ctx, `SELECT held_microfen FROM workspace_wallets WHERE org_id=$1`, org).Scan(&held)
		if unknown.Status != "unknown" || held != 750000 || generator.count() != 1 {
			t.Fatalf("authority wait %+v held %d calls %d", unknown, held, generator.count())
		}
		seedMatchingLease(t, ctx, pool, "billing", "explicit test authority recovery")
		restored := parse(request(handler, "GET", "/api/ai/image-sets/"+recoveredID, "", cookie, nil, nil))
		if restored.Status != "unknown" || generator.count() != 1 {
			t.Fatalf("recovery %+v calls %d", restored, generator.count())
		}
		assertWallet()
		_ = requestID
		_ = publicID
	})

	run("bounded preprocessing rejects before body read and cancellation releases", func(t *testing.T) {
		generator = &recordedImageGenerator{images: outputs}
		started := make(chan struct{}, 2)
		finished := make(chan struct{}, 2)
		var stops []context.CancelFunc
		for index := 0; index < 2; index++ {
			requestCtx, stop := context.WithCancel(ctx)
			stops = append(stops, stop)
			reader := &imageBlockedBody{started: started, closed: make(chan struct{})}
			go func(index int) {
				defer func() { finished <- struct{}{} }()
				req := httptest.NewRequest("POST", "/api/ai/image-sets", nil).WithContext(requestCtx)
				req.Body = reader
				req.Header.Set("Cookie", cookie)
				req.Header.Set("Idempotency-Key", fmt.Sprintf("blocked-%d", index))
				handler.ServeHTTP(httptest.NewRecorder(), req)
			}(index)
		}
		for index := 0; index < 2; index++ {
			select {
			case <-started:
			case <-time.After(3 * time.Second):
				t.Fatal("body did not enter preprocessing")
			}
		}
		busy := request(handler, "POST", "/api/ai/image-sets", "prep-busy", cookie, body, nil)
		if busy.Code != 429 || generator.count() != 0 {
			t.Fatalf("preprocessing cap %d calls %d", busy.Code, generator.count())
		}
		for _, stop := range stops {
			stop()
		}
		for index := 0; index < 2; index++ {
			select {
			case <-finished:
			case <-time.After(3 * time.Second):
				t.Fatal("cancelled body retained preprocessing gate")
			}
		}
		after := request(makeHandler(nil), "POST", "/api/ai/image-sets", "prep-released", cookie, body, nil)
		if after.Code != 503 {
			t.Fatalf("preprocessing gate not released %d", after.Code)
		}
	})
	run("long provider call retains existing billing authority", func(t *testing.T) {
		generator = &recordedImageGenerator{images: outputs, delay: 65 * time.Second}
		started := time.Now()
		result := parse(request(handler, "POST", "/api/ai/image-sets", "long-call", cookie, body, nil))
		if time.Since(started) < 65*time.Second || result.Status != "ready" || generator.count() != 3 {
			t.Fatalf("long call %+v calls %d", result, generator.count())
		}
		assertWallet()
	})
	run("database tenant guards protect group items and requests", func(t *testing.T) {
		tx, err := tenantx.BeginApp(ctx, pool.Begin, otherOrg)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		var n int
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM ai_image_sets WHERE id=$1::uuid`, ready.ID).Scan(&n); err != nil || n != 0 {
			t.Fatalf("RLS %d %v", n, err)
		}
		if _, err = tx.Exec(ctx, `UPDATE ai_image_set_items SET object_id=(SELECT object_id FROM ai_image_set_items WHERE set_id=$1::uuid LIMIT 1) WHERE org_id=$2`, ready.ID, org); err != nil {
			t.Fatal(err)
		}
		var refs int
		if err = pool.QueryRow(ctx, `SELECT count(*) FROM storage_object_refs WHERE owner_org_id=$1`, org).Scan(&refs); err != nil || refs < 4 {
			t.Fatalf("refs lost %d %v", refs, err)
		}
	})
	if dir := os.Getenv("PODHUB_AI_IMAGE_EVIDENCE_DIR"); dir != "" && ready.ID != "" && !t.Failed() {
		var saved []map[string]any
		for index, item := range ready.Items {
			parsed, _ := url.Parse(item.Asset.URL)
			bucket.mu.Lock()
			raw := append([]byte(nil), bucket.bodies["/podhub-go-supplier"+parsed.Path]...)
			bucket.mu.Unlock()
			name := fmt.Sprintf("saved-set-%d.jpg", index+1)
			if err := os.WriteFile(filepath.Join(dir, name), raw, 0600); err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256(raw)
			saved = append(saved, map[string]any{"file": name, "bytes": len(raw), "sha256": fmt.Sprintf("%x", sum), "mime": "image/jpeg"})
		}
		report := map[string]any{"normal_api_post_get": true, "database": "fresh private PostgreSQL 16", "database_login": "podhub_login_api", "superuser_or_bypassrls": false, "authentication": "real session cookie consumed by existing identity middleware and database membership resolution; cookie fixture issued by existing register route using fixture pool", "provider": "explicit substitute replaying 3 prior real provider outputs; no new inference", "storage": "local HTTP object-store substitute with actual PUT/HEAD-checksum/private GET/public GET bytes and PostgreSQL registry/reference persistence", "production_bucket_verified": false, "test_per_image_price_microfen": 250000, "fixed_images": 3, "no_auto_retry": true, "outputs": saved, "passed_cases": passedCases}
		raw, _ := json.MarshalIndent(report, "", "  ")
		if err := os.WriteFile(filepath.Join(dir, "normal-api-persistence-result.json"), append(raw, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}

}

type imageRoundTripper func(*http.Request) (*http.Response, error)

func (f imageRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type imageAssetsFunc func(context.Context, int64, int64, []byte) (ai.ImageAsset, error)

func (f imageAssetsFunc) Save(ctx context.Context, org, user int64, source []byte) (ai.ImageAsset, error) {
	return f(ctx, org, user, source)
}

type imageBlockedBody struct {
	started             chan struct{}
	closed              chan struct{}
	readOnce, closeOnce sync.Once
}

func (b *imageBlockedBody) Read([]byte) (int, error) {
	b.readOnce.Do(func() { b.started <- struct{}{} })
	<-b.closed
	return 0, io.EOF
}
func (b *imageBlockedBody) Close() error { b.closeOnce.Do(func() { close(b.closed) }); return nil }
