package integration

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptrace"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	configdoc "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/ai"
	"github.com/xxww0098/podhub-go/internal/app"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	registry "github.com/xxww0098/podhub-go/internal/media/service/registry"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

// This opt-in test has no provider/storage substitute. scripts/verify-ai-live.py
// supplies selected credentials through stdin; this process sets the storage environment.
func TestAIImageSetsLive(t *testing.T) {
	mode := os.Getenv("PODHUB_AI_LIVE_MODE")
	if mode != "preflight" && mode != "generate" {
		t.Skip("explicit live opt-in required")
	}
	out := os.Getenv("PODHUB_AI_LIVE_OUTPUT")
	if out == "" {
		t.Fatal("live evidence directory required")
	}
	if err := os.MkdirAll(out, 0700); err != nil {
		t.Fatal("evidence directory unavailable")
	}
	var remote struct {
		AI     configdoc.StoredAI      `json:"ai"`
		Assets config.R2StorageAccount `json:"assets"`
	}
	if json.NewDecoder(io.LimitReader(os.Stdin, 1<<20)).Decode(&remote) != nil {
		t.Fatal("credential stdin unavailable")
	}
	if remote.AI.APIKey == "" || remote.Assets.Bucket != "podhub-supplier" || remote.Assets.PublicBaseURL != "https://podhub-supplier.ozon-pod.com" {
		t.Fatal("unexpected live configuration")
	}
	runID := uuid.NewString()
	prefix := "podhub-live-admission-20261022/" + runID + "/"
	remote.AI.Model, remote.AI.Active, remote.AI.Purpose = "qwen-image-2.1-pro", true, configdoc.PurposeImage
	remote.Assets.Role, remote.Assets.KeyPrefix = "assets", prefix
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	t.Setenv("PODHUB_PARITY_DSN", "")
	dsn := securityDSN(t, ctx)
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	fixture, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal("fixture database unavailable")
	}
	defer fixture.Close()
	if db.Migrate(ctx, fixture) != nil {
		t.Fatal("fresh migrations failed")
	}
	if _, err = fixture.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'isolated-live-api-login'`); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	pool, err := db.Connect(ctx, config.Config{DatabaseURL: swapUser(dsn, "podhub_login_api", "isolated-live-api-login")})
	if err != nil {
		t.Fatal("normal API pool unavailable")
	}
	defer pool.Close()
	var role string
	var super, bypass, inherit bool
	if err = pool.QueryRow(ctx, `SELECT current_user,rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user`).Scan(&role, &super, &bypass, &inherit); err != nil || role != "podhub_login_api" || super || bypass || inherit {
		t.Fatal("unsafe API login role")
	}
	t.Setenv("CLOUD_COOKIE_SECURE", "0")
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "isolated-live-fixture-seller-key-32chars")
	integrationKey := uuid.NewString() + uuid.NewString()
	t.Setenv("CLOUD_INTEGRATION_CONFIG_KEY", integrationKey)
	if _, err = fixture.Exec(ctx, `INSERT INTO account_users(public_id,email,password_hash,role,name,target,supplier_id,plan,created_at,updated_at) VALUES('00000000-0000-4000-8000-000000009992','live-owner@example.invalid','x','super_admin','Owner','/workspace','','free',clock_timestamp(),clock_timestamp()); UPDATE platform_initialization SET owner_account_id=(SELECT id FROM account_users WHERE email='live-owner@example.invalid'),initialized_at=clock_timestamp() WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	// Account/session issuance is a fixture using the existing register route.
	// All consumption routes below share the standard NOINHERIT pool and Handler.
	fixtureHandler := app.Handler(fixture)
	register := func(email, key string) (string, int64, int64) {
		rec := postJSON(t, fixtureHandler, "/api/auth/register", `{"email":"`+email+`","password":"correct-horse","name":"Live Image"}`, key, "")
		if rec.Code != 200 {
			t.Fatalf("fixture register HTTP %d", rec.Code)
		}
		var org, user int64
		if fixture.QueryRow(ctx, `SELECT o.id,u.id FROM organizations o JOIN account_users u ON o.owner_user_id=u.id WHERE u.email=$1`, email).Scan(&org, &user) != nil {
			t.Fatal("fixture identity missing")
		}
		return sessionCookie(rec), org, user
	}
	cookie, org, user := register("live-image@example.invalid", "live-reg-a")
	otherCookie, _, _ := register("live-other@example.invalid", "live-reg-b")
	setR2StorageAccount(t, remote.Assets)
	snapshot, err := json.Marshal(configdoc.Snapshot{SchemaVersion: 1, AIAccounts: []configdoc.StoredAI{remote.AI}})
	if err != nil {
		t.Fatal("snapshot encoding failed")
	}
	kek, err := seal.IntegrationKEK(integrationKey)
	if err != nil {
		t.Fatal("local integration key invalid")
	}
	nonce, ciphertext, err := seal.SealBlob(kek, seal.SnapshotAAD, snapshot)
	if err != nil {
		t.Fatal("snapshot sealing failed")
	}
	if _, err = fixture.Exec(ctx, `INSERT INTO platform_integration_config(singleton,revision,nonce,ciphertext,updated_at_ms,updated_by_account_uuid) VALUES(true,1,$1,$2,$3,'live-fixture')`, nonce, ciphertext, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	seedMatchingLease(t, ctx, fixture, "billing", "isolated live AI verification")
	const unit int64 = 25_000_000 // 0.25 CNY; 1 CNY is 100,000,000 microfen.
	const seed int64 = 1_000_000_000
	if _, err = billingrepo.Adjust(ctx, fixture, org, "live-seed", seed, "isolated fixture credit"); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.Exec(ctx, `INSERT INTO ai_price_schedules(model,billing_mode,input_microfen_per_million,cached_input_microfen_per_million,output_microfen_per_million,reasoning_microfen_per_million,per_request_microfen,max_request_microfen,effective_from) VALUES('qwen-image-2.1-pro','per_request',0,0,0,0,$1,$1,clock_timestamp())`, unit); err != nil {
		t.Fatal(err)
	}
	network := ai.ImageNetworkClient()
	original := network.Transport
	observer := &liveImageTransport{inner: original, ledger: filepath.Join(out, "provider-attempts.jsonl"), allow: mode == "generate"}
	network.Transport = observer
	defer func() { network.Transport = original }()
	handler := app.Handler(pool)
	capabilityResponse := get(t, handler, "/api/ai/image-sets/capability", cookie)
	var capability ai.ImageSetCapability
	if capabilityResponse.Code != 200 || json.Unmarshal(capabilityResponse.Body.Bytes(), &capability) != nil || !capability.Available || capability.AccountID != remote.AI.ID || capability.UnitMicrofen != unit || capability.SetMicrofen != 3*unit {
		t.Fatalf("real capability HTTP %d available=%v", capabilityResponse.Code, capability.Available)
	}
	liveWrite(t, out, "capability.json", capability)
	rawSource, err := os.ReadFile(filepath.Join(os.Getenv("PODHUB_AI_LIVE_REPO"), "web/public/site/product-tote.jpg"))
	if err != nil {
		t.Fatal("public tote fixture unavailable")
	}
	source := liveImageJPEG(t, rawSource)
	account := registry.Account{ID: remote.Assets.ID, Provider: "cloudflare", Endpoint: remote.Assets.Endpoint, Region: "auto", Bucket: remote.Assets.Bucket, KeyPrefix: prefix, PublicBaseURL: remote.Assets.PublicBaseURL, ForcePathStyle: true, AccessKeyID: remote.Assets.AccessKeyID, SecretAccessKey: remote.Assets.SecretAccessKey, SessionToken: remote.Assets.SessionToken}
	assets := app.NewRegistryImageAssets(pool, account, nil)
	start := time.Now().UTC()
	var phaseMu sync.Mutex
	var phases []map[string]any
	phase := func(value map[string]any) {
		phaseMu.Lock()
		defer phaseMu.Unlock()
		value["time"] = time.Now().UTC()
		phases = append(phases, value)
	}
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		ConnectDone: func(_, _ string, err error) {
			phase(map[string]any{"phase": "connect", "error_type": fmt.Sprintf("%T", err)})
		},
		TLSHandshakeDone: func(_ tls.ConnectionState, err error) {
			phase(map[string]any{"phase": "tls_handshake", "error_type": fmt.Sprintf("%T", err)})
		},
	})
	sourceAsset, err := assets.Save(ctx, org, user, source)
	if err != nil {
		phaseMu.Lock()
		phaseCopy := append([]map[string]any(nil), phases...)
		phaseMu.Unlock()
		liveWrite(t, out, "storage-preflight.json", map[string]any{"passed": false, "stage": "source_save", "error": err.Error(), "network": observer.snapshot(), "network_phases": phaseCopy, "provider_attempts": observer.count(), "bucket": account.Bucket, "public_base": account.PublicBaseURL, "prefix": prefix})
		t.Fatalf("real source storage preflight: %v", err)
	}
	proof := livePublicImage(t, ctx, sourceAsset.URL, sourceAsset.SHA256)
	delete(proof, "pixels")
	preflight := map[string]any{"passed": true, "started_at": start, "completed_at": time.Now().UTC(), "fresh_postgresql": true, "role": role, "rolsuper": super, "rolbypassrls": bypass, "rolinherit": inherit, "authentication": "real session cookie; existing register route used only for fixture issuance", "composition": "app.Handler + newImageRuntime for capability; NewRegistryImageAssets for source preflight", "bucket": account.Bucket, "public_base": account.PublicBaseURL, "prefix": prefix, "head_checksum": "Actual HEAD SHA256/CRC64 presence recorded per request; complete GET SHA256 also required", "source": proof, "network": observer.snapshot(), "provider_attempts": observer.count(), "lifecycle": "GetBucketLifecycleConfiguration denied AccessDenied; rules unknown; no known cleanup targets this isolated prefix"}
	liveWrite(t, out, "storage-preflight.json", preflight)
	if observer.count() != 0 {
		t.Fatal("preflight made a provider request")
	}
	if err = os.WriteFile(filepath.Join(out, "source-product-tote.jpg"), source, 0600); err != nil {
		t.Fatal(err)
	}
	if mode == "preflight" {
		t.Log("PASS real R2 conditional PUT, HEAD metadata, independent private/public SHA256; zero inference calls")
		return
	}
	if prior, err := os.ReadFile(observer.ledger); err == nil && len(prior) > 0 {
		t.Fatal("refusing another paid run")
	}
	// Re-authorize only this local fixture before the paid transaction starts.
	seedMatchingLease(t, ctx, fixture, "billing", "isolated live AI generation")
	idem := "live-image-set-" + runID
	body, _ := json.Marshal(map[string]any{"account_id": capability.AccountID, "model": capability.Model, "source_base64": base64.StdEncoding.EncodeToString(rawSource), "expected_unit_microfen": capability.UnitMicrofen})
	response := postJSON(t, handler, "/api/ai/image-sets", string(body), idem, cookie)
	var view ai.ImageSetView
	if json.Unmarshal(response.Body.Bytes(), &view) != nil {
		t.Fatalf("POST returned invalid JSON HTTP %d", response.Code)
	}
	liveWrite(t, out, "post-response.json", view)
	report := map[string]any{"passed": false, "started_at": start, "completed_at": time.Now().UTC(), "post_http_status": response.Code, "post": view, "idempotency_key_sha256": imageLiveDigest([]byte(idem)), "set_id_sha256": imageLiveDigest([]byte(view.ID)), "provider_attempts": observer.count(), "network": observer.snapshot(), "actual_provider": true, "actual_r2": true, "composition": "unchanged app.Handler(apiPool) -> newImageRuntime -> real provider and real registry assets; no replay or injected principal", "authentication": "real cookie + existing middleware + PG membership; register only fixture pool", "database": "fresh PG16 fully migrated; podhub_login_api NOINHERIT NOSUPERUSER NOBYPASSRLS for capability/POST/GET/storage", "price_unit_microfen": unit, "price_set_microfen": 3 * unit, "public_price_cny_per_image": "0.25", "estimated_external_cost_cny": "0.75", "external_invoice_or_free_quota_verified": false, "production_configuration_changed": false, "prefix": prefix, "lifecycle": "unknown due AccessDenied; no known cleanup of isolated prefix"}
	defer func() {
		report["completed_at"] = time.Now().UTC()
		report["provider_attempts"] = observer.count()
		report["network"] = observer.snapshot()
		liveWrite(t, out, "live-validation.json", report)
	}()
	if response.Code != 200 || view.Status != "ready" || len(view.Items) != 3 || observer.count() != 3 {
		t.Fatalf("live generation HTTP %d status=%s items=%d attempts=%d", response.Code, view.Status, len(view.Items), observer.count())
	}
	var outputProofs []map[string]any
	for _, item := range view.Items {
		if item.Status != "ready" || item.Asset == nil || item.Charged != unit {
			t.Fatalf("item %d not settled and stored", item.Ordinal)
		}
		got := livePublicImage(t, ctx, item.Asset.URL, item.Asset.SHA256)
		outputProofs = append(outputProofs, got)
		if err = os.WriteFile(filepath.Join(out, fmt.Sprintf("set-%d.jpg", item.Ordinal+1)), got["pixels"].([]byte), 0600); err != nil {
			t.Fatal(err)
		}
		delete(got, "pixels")
	}
	report["public_outputs"] = outputProofs
	fetched := get(t, handler, "/api/ai/image-sets/"+view.ID, cookie)
	var fromGET ai.ImageSetView
	if fetched.Code != 200 || json.Unmarshal(fetched.Body.Bytes(), &fromGET) != nil || fromGET.Status != "ready" || fromGET.ID != view.ID || len(fromGET.Items) != 3 {
		t.Fatalf("group GET HTTP %d", fetched.Code)
	}
	liveWrite(t, out, "group-get.json", fromGET)
	report["get_http_status"] = fetched.Code
	replay := postJSON(t, handler, "/api/ai/image-sets", string(body), idem, cookie)
	var replayed ai.ImageSetView
	if replay.Code != 200 || json.Unmarshal(replay.Body.Bytes(), &replayed) != nil || replayed.ID != view.ID || observer.count() != 3 {
		t.Fatal("same-key replay repeated inference or changed set")
	}
	report["same_key_replay_http_status"], report["same_key_replay_additional_provider_calls"] = replay.Code, 0
	denied := get(t, handler, "/api/ai/image-sets/"+view.ID, otherCookie)
	if denied.Code != 404 {
		t.Fatalf("cross-org GET HTTP %d", denied.Code)
	}
	report["cross_org_get_http_status"] = denied.Code
	var items, settled, objects, refs, logs int
	var charged, held, balance int64
	if err = fixture.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE r.status='settled'),COALESCE(sum(r.charged_microfen),0) FROM ai_image_set_items i JOIN ai_requests r ON r.id=i.request_id AND r.org_id=i.org_id WHERE i.set_id=$1::uuid AND i.org_id=$2`, view.ID, org).Scan(&items, &settled, &charged); err != nil {
		t.Fatal(err)
	}
	if err = fixture.QueryRow(ctx, `SELECT count(*) FROM storage_objects WHERE object_key LIKE $1 AND state='live'`, prefix+"%").Scan(&objects); err != nil {
		t.Fatal(err)
	}
	if err = fixture.QueryRow(ctx, `SELECT count(*) FROM storage_object_refs WHERE object_id IN (SELECT id FROM storage_objects WHERE object_key LIKE $1)`, prefix+"%").Scan(&refs); err != nil {
		t.Fatal(err)
	}
	if err = fixture.QueryRow(ctx, `SELECT count(*) FROM ai_consume_logs l JOIN ai_image_set_items i ON i.request_id=l.ai_request_id WHERE i.set_id=$1::uuid`, view.ID).Scan(&logs); err != nil {
		t.Fatal(err)
	}
	if err = fixture.QueryRow(ctx, `SELECT held_microfen,balance_microfen FROM workspace_wallets WHERE org_id=$1`, org).Scan(&held, &balance); err != nil {
		t.Fatal(err)
	}
	report["independent_database_readback"] = map[string]any{"items": items, "settled_requests": settled, "charged_microfen": charged, "live_objects": objects, "business_refs": refs, "consume_logs": logs, "wallet_held_microfen": held, "wallet_balance_microfen": balance, "seed_credit_microfen": seed}
	if items != 3 || settled != 3 || charged != 3*unit || objects != 4 || refs != 4 || logs != 3 || held != 0 || balance != seed-3*unit {
		t.Fatal("independent database/wallet readback mismatch")
	}
	report["passed"] = true
	t.Log("PASS fresh actual model POST x3 n=1, actual R2 assets and GET, normal cookie/role, wallet and replay readback")
}

func liveImageJPEG(t *testing.T, raw []byte) []byte {
	t.Helper()
	img, err := jpeg.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatal("fixture JPEG invalid")
	}
	dst := image.NewRGBA(img.Bounds())
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(dst, dst.Bounds(), img, img.Bounds().Min, draw.Over)
	var out bytes.Buffer
	if jpeg.Encode(&out, dst, &jpeg.Options{Quality: 92}) != nil {
		t.Fatal("fixture JPEG conversion failed")
	}
	return out.Bytes()
}
func imageLiveDigest(raw []byte) string { return sha256Hex(string(raw)) }
func liveWrite(t *testing.T, out, name string, value any) {
	t.Helper()
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal("evidence encoding failed")
	}
	if os.WriteFile(filepath.Join(out, name), raw, 0600) != nil {
		t.Fatal("evidence write failed")
	}
}
func livePublicImage(t *testing.T, ctx context.Context, url, digest string) map[string]any {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatal("public URL invalid")
	}
	client := ai.NewImageClient("podhub-supplier.ozon-pod.com")
	defer client.CloseIdleConnections()
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal("independent public GET unavailable")
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 20<<20+1))
	if err != nil || resp.StatusCode != 200 || len(raw) > 20<<20 || imageLiveDigest(raw) != digest {
		t.Fatalf("independent public GET proof failed HTTP %d", resp.StatusCode)
	}
	return map[string]any{"http_status": resp.StatusCode, "sha256": digest, "byte_length": len(raw), "pixels": raw}
}

type liveImageTransport struct {
	mu       sync.Mutex
	inner    http.RoundTripper
	ledger   string
	allow    bool
	attempts int
	events   []map[string]any
}

func (s *liveImageTransport) count() int { s.mu.Lock(); defer s.mu.Unlock(); return s.attempts }
func (s *liveImageTransport) snapshot() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any(nil), s.events...)
}
func (s *liveImageTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	kind := "provider_output_get"
	if strings.HasSuffix(r.URL.Hostname(), ".r2.cloudflarestorage.com") {
		kind = "r2"
	}
	event := map[string]any{"time": time.Now().UTC(), "target": kind, "method": r.Method}
	if r.Method == http.MethodPost && r.URL.Path == "/compatible-mode/v1/images/generations" {
		if !s.allow || r.GetBody == nil {
			return nil, fmt.Errorf("live model budget refused")
		}
		body, err := r.GetBody()
		if err != nil {
			return nil, fmt.Errorf("live request unavailable")
		}
		var request struct {
			N     int    `json:"n"`
			Model string `json:"model"`
		}
		err = json.NewDecoder(body).Decode(&request)
		body.Close()
		if err != nil || request.N != 1 || request.Model != "qwen-image-2.1-pro" {
			return nil, fmt.Errorf("live request shape refused")
		}
		s.mu.Lock()
		if s.attempts >= 3 {
			s.mu.Unlock()
			return nil, fmt.Errorf("live model cap exceeded")
		}
		s.attempts++
		event["target"], event["n"], event["model"], event["attempt"] = "provider", 1, request.Model, s.attempts
		f, e := os.OpenFile(s.ledger, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
		if e == nil {
			e = json.NewEncoder(f).Encode(event)
			if e == nil {
				e = f.Sync()
			}
			f.Close()
		}
		s.mu.Unlock()
		if e != nil {
			return nil, fmt.Errorf("budget ledger unavailable")
		}
	}
	resp, err := s.inner.RoundTrip(r)
	event["transport_error"] = err != nil
	if resp != nil {
		event["http_status"] = resp.StatusCode
		event["content_length"] = resp.ContentLength
		if r.Method == http.MethodHead {
			event["head_sha256_present"] = resp.Header.Get("X-Amz-Checksum-Sha256") != ""
			event["head_crc64_present"] = resp.Header.Get("X-Amz-Checksum-Crc64nvme") != ""
		}
		if event["target"] == "provider" {
			var capture bytes.Buffer
			originalBody := resp.Body
			resp.Body = &liveImageResponseBody{Reader: io.TeeReader(originalBody, &capture), close: func() error {
				var shape struct {
					Model string            `json:"model"`
					Data  []json.RawMessage `json:"data"`
					Usage struct {
						Count int `json:"image_count"`
					} `json:"usage"`
				}
				if json.Unmarshal(capture.Bytes(), &shape) == nil {
					s.mu.Lock()
					event["model_echoed"], event["returned_model"] = shape.Model != "", shape.Model
					event["usage_image_count"], event["data_count"] = shape.Usage.Count, len(shape.Data)
					s.mu.Unlock()
				}
				return originalBody.Close()
			}}
		}
	}
	s.mu.Lock()
	s.events = append(s.events, event)
	s.mu.Unlock()
	return resp, err
}

type liveImageResponseBody struct {
	io.Reader
	close func() error
}

func (b *liveImageResponseBody) Close() error { return b.close() }
