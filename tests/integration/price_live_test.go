package integration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/app"
	opsdomain "github.com/xxww0098/podhub-go/internal/ops/domain"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
	seller "github.com/xxww0098/podhub-go/internal/seller/ozon"
)

const priceLiveOffer = "podhub-live-validation-f8c58027486c4ad9bd6dbdfd"
const priceLiveProduct int64 = 6706622142

type priceAPI struct {
	handler                    http.Handler
	cookie, store              string
	org, user, member, storePK int64
	pool, fixture              *pgxpool.Pool
}

func newPriceAPI(t *testing.T, clientID, apiKey, base string) priceAPI {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	t.Cleanup(cancel)
	t.Setenv("PODHUB_PARITY_DSN", "")
	dsn := securityDSN(t, ctx)
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	fixture, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(fixture.Close)
	if err = db.Migrate(ctx, fixture); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'isolated-price-login'`); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	poolConfig, err := pgxpool.ParseConfig(swapUser(dsn, "podhub_login_api", "isolated-price-login"))
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var name string
	var super, inherit, bypass bool
	if pool.QueryRow(ctx, `SELECT current_user,rolsuper,rolinherit,rolbypassrls FROM pg_roles WHERE rolname=current_user`).Scan(&name, &super, &inherit, &bypass) != nil || name != "podhub_login_api" || super || inherit || bypass {
		t.Fatal("unsafe API pool")
	}
	t.Setenv("CLOUD_COOKIE_SECURE", "0")
	t.Setenv("CLOUD_SELLER_BASE_URL", base)
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", uuid.NewString()+uuid.NewString())
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY_ID", seal.DefaultSellerKeyID)
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY_PREVIOUS", "")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	if _, err = fixture.Exec(ctx, `INSERT INTO account_users(public_id,email,password_hash,role,name,target,supplier_id,plan,created_at,updated_at) VALUES('00000000-0000-4000-8000-000000009991','price-owner@example.invalid','x','super_admin','Owner','/workspace','','free',clock_timestamp(),clock_timestamp()); UPDATE platform_initialization SET owner_account_id=(SELECT id FROM account_users WHERE email='price-owner@example.invalid'),initialized_at=clock_timestamp() WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	registered := postJSON(t, app.Handler(fixture), "/api/auth/register", `{"email":"price-live@example.invalid","password":"correct-horse","name":"Price validation"}`, "price-register", "")
	if registered.Code != 200 {
		t.Fatalf("fixture registration HTTP %d", registered.Code)
	}
	a := priceAPI{pool: pool, fixture: fixture, cookie: sessionCookie(registered), handler: app.Handler(pool)}
	if err = fixture.QueryRow(ctx, `SELECT o.id,u.id,m.id FROM organizations o JOIN account_users u ON u.id=o.owner_user_id JOIN organization_members m ON m.org_id=o.id AND m.user_id=u.id WHERE u.email='price-live@example.invalid'`).Scan(&a.org, &a.user, &a.member); err != nil {
		t.Fatal(err)
	}
	seedMatchingLease(t, ctx, fixture, "entitlement", "isolated normal-role price validation")
	body, _ := json.Marshal(map[string]any{"name": "Price validation", "client_id": clientID, "assignee_membership_id": a.member})
	created := postJSON(t, a.handler, "/api/workspaces/stores", string(body), "price-store", a.cookie)
	var store struct {
		Store struct {
			UUID     string `json:"uuid"`
			Revision int64  `json:"revision"`
		} `json:"store"`
	}
	if created.Code != 200 || json.Unmarshal(created.Body.Bytes(), &store) != nil || store.Store.UUID == "" {
		t.Fatalf("normal store create HTTP %d", created.Code)
	}
	a.store = store.Store.UUID
	body, _ = json.Marshal(map[string]any{"client_id": clientID, "api_key": apiKey, "confirm_upload": true, "expected_store_revision": store.Store.Revision, "expected_credential_revision": nil})
	credential := postJSON(t, a.handler, "/api/workspaces/stores/"+a.store+"/credential", string(body), "price-credential", a.cookie)
	if credential.Code != 200 {
		t.Fatalf("normal credential register HTTP %d", credential.Code)
	}
	var version int
	if fixture.QueryRow(ctx, `SELECT s.id,c.envelope_version FROM organization_stores s JOIN store_seller_credentials c ON c.store_id=s.id AND c.org_id=s.org_id AND c.credential_revision=s.credential_revision WHERE s.org_id=$1 AND s.uuid=$2::uuid`, a.org, a.store).Scan(&a.storePK, &version) != nil || version != 2 {
		t.Fatal("normal v2 credential missing")
	}
	return a
}

func priceMutation(store, operation, price string) []byte {
	body, _ := json.Marshal(map[string]any{"store_id": store, "operation_id": operation, "request": map[string]any{"kind": "price", "items": []any{map[string]any{"product_id": priceLiveProduct, "offer_id": priceLiveOffer, "price": price, "old_price": "0", "currency_code": "CNY"}}}})
	return body
}

func TestOpsPriceNormalAPI(t *testing.T) {
	var writes atomic.Int32
	var receipt atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/seller/info":
			_, _ = w.Write([]byte(`{"company":{"name":"Price fixture"}}`))
		case "/v1/roles":
			_, _ = w.Write([]byte(`{"roles":[{"name":"test","methods":["/v1/product/import/prices"]}]}`))
		case "/v1/product/import/prices":
			writes.Add(1)
			switch receipt.Load() {
			case 1:
				_, _ = w.Write([]byte(`{"result":[{"product_id":6706622142,"offer_id":"podhub-live-validation-f8c58027486c4ad9bd6dbdfd","updated":false,"errors":[{"code":"PRICE","message":"price rejected"}]}]}`))
			case 2:
				_, _ = w.Write([]byte(`{}`))
			default:
				_, _ = w.Write([]byte(`{"result":[{"product_id":6706622142,"offer_id":"podhub-live-validation-f8c58027486c4ad9bd6dbdfd","updated":true,"errors":[]}]}`))
			}
		default:
			t.Errorf("unexpected upstream path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	a := newPriceAPI(t, "fixture-price-client", "fixture-price-key", upstream.URL+"/")
	cmd := priceMutation(a.store, uuid.NewString(), "62.01")
	closed := postJSON(t, a.handler, "/api/ops/products/mutate", string(cmd), "price-write", a.cookie)
	if closed.Code != 503 || !strings.Contains(closed.Body.String(), `"code":"writes_disabled"`) || writes.Load() != 0 {
		t.Fatalf("closed normal-role mutation HTTP %d body=%s writes=%d", closed.Code, closed.Body.String(), writes.Load())
	}
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	a.handler = app.Handler(a.pool)
	changed := postJSON(t, a.handler, "/api/ops/products/mutate", string(cmd), "price-write", a.cookie)
	if changed.Code != 200 || !strings.Contains(changed.Body.String(), `"succeeded":true`) || writes.Load() != 1 {
		t.Fatalf("normal-role price HTTP %d body=%s writes=%d", changed.Code, changed.Body.String(), writes.Load())
	}
	replay := postJSON(t, a.handler, "/api/ops/products/mutate", string(cmd), "price-replay", a.cookie)
	if replay.Code != 200 || writes.Load() != 1 {
		t.Fatal("settled replay dispatched again")
	}
	ctx := context.Background()
	var state string
	var count int
	if a.fixture.QueryRow(ctx, `SELECT count(*),min(state) FROM seller_upstream_writes WHERE org_id=$1 AND store_id=$2`, a.org, a.storePK).Scan(&count, &state) != nil || count != 1 || state != "settled" {
		t.Fatalf("durable ledger count=%d state=%s", count, state)
	}
	changedIntent := postJSON(t, a.handler, "/api/ops/products/mutate", strings.Replace(string(cmd), "62.01", "62.02", 1), "price-changed-replay", a.cookie)
	if changedIntent.Code != 409 || writes.Load() != 1 {
		t.Fatal("changed operation body was dispatched")
	}
	foreign := postJSON(t, app.Handler(a.fixture), "/api/auth/register", `{"email":"price-foreign@example.invalid","password":"correct-horse","name":"Other org"}`, "price-foreign-register", "")
	if foreign.Code != 200 {
		t.Fatal("foreign fixture registration failed")
	}
	foreignWrite := postJSON(t, a.handler, "/api/ops/products/mutate", string(priceMutation(a.store, uuid.NewString(), "62.01")), "price-foreign", sessionCookie(foreign))
	if foreignWrite.Code != 404 || writes.Load() != 1 {
		t.Fatalf("foreign store HTTP %d writes=%d", foreignWrite.Code, writes.Load())
	}
	if _, err := a.fixture.Exec(ctx, `UPDATE organization_stores SET manual_disabled=true WHERE id=$1`, a.storePK); err != nil {
		t.Fatal(err)
	}
	disabled := postJSON(t, a.handler, "/api/ops/products/mutate", string(priceMutation(a.store, uuid.NewString(), "62.01")), "price-disabled", a.cookie)
	if disabled.Code != 403 || writes.Load() != 1 {
		t.Fatal("disabled store dispatched")
	}
	if _, err := a.fixture.Exec(ctx, `UPDATE organization_stores SET manual_disabled=false,credential_revision=credential_revision+1 WHERE id=$1`, a.storePK); err != nil {
		t.Fatal(err)
	}
	stale := postJSON(t, a.handler, "/api/ops/products/mutate", string(priceMutation(a.store, uuid.NewString(), "62.01")), "price-stale-credential", a.cookie)
	if stale.Code != 409 || writes.Load() != 1 {
		t.Fatal("stale credential generation dispatched")
	}
	if _, err := a.fixture.Exec(ctx, `UPDATE organization_stores SET credential_revision=credential_revision-1 WHERE id=$1`, a.storePK); err != nil {
		t.Fatal(err)
	}
	if _, err := a.fixture.Exec(ctx, `UPDATE store_seller_credentials SET key_expires_at_ms=1 WHERE store_id=$1`, a.storePK); err != nil {
		t.Fatal(err)
	}
	expired := postJSON(t, a.handler, "/api/ops/products/mutate", string(priceMutation(a.store, uuid.NewString(), "62.01")), "price-expired-credential", a.cookie)
	if expired.Code != 409 || writes.Load() != 1 {
		t.Fatal("expired credential dispatched")
	}
	if _, err := a.fixture.Exec(ctx, `UPDATE store_seller_credentials SET key_expires_at_ms=NULL WHERE store_id=$1`, a.storePK); err != nil {
		t.Fatal(err)
	}
	var fingerprint, nonce []byte
	if err := a.fixture.QueryRow(ctx, `SELECT key_fingerprint,nonce FROM store_seller_credentials WHERE store_id=$1`, a.storePK).Scan(&fingerprint, &nonce); err != nil {
		t.Fatal(err)
	}
	for _, negative := range []struct {
		name, change, restore string
		value                 any
	}{
		{"fingerprint", `UPDATE store_seller_credentials SET key_fingerprint=decode(repeat('00',32),'hex') WHERE store_id=$1`, `UPDATE store_seller_credentials SET key_fingerprint=$2 WHERE store_id=$1`, fingerprint},
		{"AAD ciphertext", `UPDATE store_seller_credentials SET nonce=decode(repeat('00',12),'hex') WHERE store_id=$1`, `UPDATE store_seller_credentials SET nonce=$2 WHERE store_id=$1`, nonce},
		{"ClientID binding", `UPDATE organization_stores SET client_id='other-fixture-client' WHERE id=$1`, `UPDATE organization_stores SET client_id=$2 WHERE id=$1`, "fixture-price-client"},
	} {
		if _, err := a.fixture.Exec(ctx, negative.change, a.storePK); err != nil {
			t.Fatal(err)
		}
		denied := postJSON(t, a.handler, "/api/ops/products/mutate", string(priceMutation(a.store, uuid.NewString(), "62.01")), "price-tampered", a.cookie)
		if denied.Code != 500 || writes.Load() != 1 {
			t.Fatalf("%s HTTP%d writes%d", negative.name, denied.Code, writes.Load())
		}
		if _, err := a.fixture.Exec(ctx, negative.restore, a.storePK, negative.value); err != nil {
			t.Fatal(err)
		}
	}
	receipt.Store(1)
	rejected := postJSON(t, a.handler, "/api/ops/products/mutate", string(priceMutation(a.store, uuid.NewString(), "62.01")), "price-rejected", a.cookie)
	if rejected.Code != 200 || !strings.Contains(rejected.Body.String(), `"succeeded":false`) || writes.Load() != 2 {
		t.Fatal("explicit item rejection incorrectly succeeded")
	}
	receipt.Store(2)
	unknownBody := priceMutation(a.store, uuid.NewString(), "62.01")
	unknown := postJSON(t, a.handler, "/api/ops/products/mutate", string(unknownBody), "price-unknown", a.cookie)
	if unknown.Code != 409 || !strings.Contains(unknown.Body.String(), `"code":"seller_result_unknown"`) || writes.Load() != 3 {
		t.Fatalf("malformed price HTTP %d body=%s writes=%d", unknown.Code, unknown.Body.String(), writes.Load())
	}
	repeated := postJSON(t, a.handler, "/api/ops/products/mutate", string(unknownBody), "price-unknown-replay", a.cookie)
	if repeated.Code != 409 || writes.Load() != 3 {
		t.Fatal("unknown operation automatically resent")
	}
	renamed := postJSON(t, a.handler, "/api/ops/products/mutate", string(priceMutation(a.store, uuid.NewString(), "62.02")), "price-unknown-new-operation", a.cookie)
	if renamed.Code != 409 || !strings.Contains(renamed.Body.String(), `"code":"seller_result_unknown"`) || writes.Load() != 3 {
		t.Fatal("new operation ID bypassed unknown price target")
	}
	settledReplay := postJSON(t, a.handler, "/api/ops/products/mutate", string(cmd), "price-settled-replay-while-unknown", a.cookie)
	if settledReplay.Code != 200 || writes.Load() != 3 {
		t.Fatal("pending later price blocked settled original replay")
	}
	if a.fixture.QueryRow(ctx, `SELECT count(*) FROM seller_upstream_writes WHERE org_id=$1 AND store_id=$2 AND state='result_unknown'`, a.org, a.storePK).Scan(&count) != nil || count != 1 {
		t.Fatal("unknown result was not durable")
	}
	var role string
	if a.pool.QueryRow(ctx, `SELECT current_setting('role')`).Scan(&role) != nil || role != "none" {
		t.Fatal("role leaked")
	}
	err := a.pool.QueryRow(ctx, `SELECT count(*) FROM store_seller_credentials`).Scan(&count)
	pgErr, ok := err.(*pgconn.PgError)
	if !ok || pgErr.Code != "42501" {
		t.Fatalf("raw credential table granted: %v", err)
	}
}

// The runner alone supplies an authorized key on stdin. Preflight never writes.
func TestOpsPriceLive(t *testing.T) {
	mode := os.Getenv("PODHUB_PRICE_LIVE_MODE")
	if mode != "preflight" && mode != "submit" {
		t.Skip("explicit live price runner required")
	}
	out := os.Getenv("PODHUB_PRICE_LIVE_OUTPUT")
	if out == "" {
		t.Fatal("evidence directory required")
	}
	var input struct {
		ClientID string `json:"client_id"`
		APIKey   string `json:"api_key"`
	}
	if json.NewDecoder(io.LimitReader(os.Stdin, 1<<20)).Decode(&input) != nil || input.ClientID != "4877007" || input.APIKey == "" {
		t.Fatal("authorized target credential stdin unavailable")
	}
	report := map[string]any{"passed": false, "mode": mode, "started_at": time.Now().UTC(), "seller_price_writes": 0, "production_database_writes": 0, "deployment_changes": 0, "offer_id": priceLiveOffer, "product_id": priceLiveProduct, "pricing_basis": "One-cent controlled price transport verification only; not a profit-derived price or complete automatic pricing admission"}
	defer func() {
		report["completed_at"] = time.Now().UTC()
		priceEvidence(t, out, "price-"+mode+".json", report)
	}()
	a := newPriceAPI(t, input.ClientID, input.APIKey, "")
	report["authentication"] = "Real fixture-issued session cookie; normal NOINHERIT API pool, ordinary store and v2 credential registration; no SQL credential/session/readiness injection"
	report["api_role"] = map[string]any{"name": "podhub_login_api", "inherit": false, "superuser": false, "bypass_rls": false, "max_connections": 1}
	var revision int64
	if a.fixture.QueryRow(context.Background(), `SELECT credential_revision FROM organization_stores WHERE org_id=$1 AND id=$2`, a.org, a.storePK).Scan(&revision) != nil {
		t.Fatal("current credential revision unavailable")
	}
	reader, err := seller.NewOfficialReader(seller.StoreScope{OrgID: a.org, StorePK: a.storePK, StoreUUID: a.store, CredentialRevision: revision}, input.ClientID, input.APIKey)
	if err != nil {
		t.Fatal("official reader unavailable")
	}
	before, raw := priceReadback(t, reader)
	priceEvidence(t, out, "price-before.json", json.RawMessage(raw))
	if before.Price != "62.00" || before.Currency != "CNY" || before.OldPrice != "" && before.OldPrice != "0" && before.OldPrice != "0.00" || before.Stocks.HasStock {
		t.Fatal("target no longer matches reviewed zero-stock 62.00CNY baseline")
	}
	report["before"] = map[string]any{"price": before.Price, "currency": before.Currency, "old_price": before.OldPrice, "has_stock": before.Stocks.HasStock}
	plan, _ := json.Marshal(map[string]any{"prices": []any{map[string]any{"product_id": priceLiveProduct, "offer_id": priceLiveOffer, "price": "62.01", "old_price": "0", "currency_code": "CNY"}}})
	digest := sha256.Sum256(plan)
	planHash := hex.EncodeToString(digest[:])
	if err = os.WriteFile(filepath.Join(out, "planned-price.json"), plan, 0600); err != nil {
		t.Fatal("cannot save plan")
	}
	report["planned_wire_sha256"] = planHash
	report["planned_price"] = "62.01"
	report["old_price_policy"] = "Before is empty/zero; submit 0 preserves no strike-through price. No min price, promotion, stock or automatic pricing fields."
	operation := uuid.NewString()
	cmd := priceMutation(a.store, operation, "62.01")
	closed := postJSON(t, a.handler, "/api/ops/products/mutate", string(cmd), "price-preflight", a.cookie)
	report["closed_gate_http"] = closed.Code
	if closed.Code != 503 || !strings.Contains(closed.Body.String(), `"code":"writes_disabled"`) {
		report["blocked_stage"] = "normal_ops_admission"
		t.Fatalf("closed gate HTTP %d: %s", closed.Code, closed.Body.String())
	}
	var count int
	if a.fixture.QueryRow(context.Background(), `SELECT count(*) FROM seller_upstream_writes WHERE org_id=$1`, a.org).Scan(&count) != nil || count != 0 {
		t.Fatal("closed gate created write ledger")
	}
	if mode == "preflight" {
		report["passed"] = true
		return
	}
	decoded, err := opsdomain.DecodeMutation(cmd)
	if err != nil || opsdomain.ValidateMutation(decoded) != nil {
		t.Fatal("reviewed normal mutation invalid")
	}
	var emitted []byte
	_, _, _ = opsdomain.Dispatch(decoded, func(method, path string, body []byte) opsdomain.Page {
		if method != "POST" || path != "/v1/product/import/prices" || emitted != nil {
			t.Fatal("unexpected shared transform")
		}
		emitted = append([]byte(nil), body...)
		return opsdomain.Page{Status: 400, Body: `{"message":"dry inspection only"}`}
	})
	if string(emitted) != string(plan) {
		t.Fatal("shared actual dispatch transform differs from reviewed wire")
	}
	report["wire_hash_evidence"] = "Exact shared domain.Dispatch output captured dry in the same binary immediately before normal Handler call; not a socket packet capture"
	approved, err := os.ReadFile(os.Getenv("PODHUB_PRICE_APPROVED_PLAN"))
	if err != nil || string(approved) != string(plan) || os.Getenv("PODHUB_PRICE_APPROVED_SHA256") != planHash {
		t.Fatal("exact reviewed immutable price plan required")
	}
	ledger := os.Getenv("PODHUB_PRICE_WRITE_LEDGER")
	if ledger == "" {
		t.Fatal("global one-write budget ledger required")
	}
	f, err := os.OpenFile(ledger, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal("write budget already used or unavailable")
	}
	entry, _ := json.Marshal(map[string]any{"at": time.Now().UTC(), "path": "/v1/product/import/prices", "operation_id": operation, "offer_id": priceLiveOffer, "wire_sha256": planHash, "max_attempts": 1})
	if _, err = f.Write(append(entry, '\n')); err != nil {
		f.Close()
		t.Fatal("write budget ledger failed")
	}
	if err = f.Sync(); err != nil {
		f.Close()
		t.Fatal("write budget fsync failed")
	}
	if err = f.Close(); err != nil {
		t.Fatal("write budget close failed")
	}
	directory, err := os.Open(filepath.Dir(ledger))
	if err != nil {
		t.Fatal("write budget directory unavailable")
	}
	err = directory.Sync()
	directory.Close()
	if err != nil {
		t.Fatal("write budget directory fsync failed")
	}
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	a.handler = app.Handler(a.pool)
	var requestEvents, completedWrites atomic.Int32
	trace := &httptrace.ClientTrace{WroteRequest: func(info httptrace.WroteRequestInfo) {
		requestEvents.Add(1)
		if info.Err == nil {
			completedWrites.Add(1)
		}
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/ops/products/mutate", strings.NewReader(string(cmd))).WithContext(httptrace.WithClientTrace(context.Background(), trace))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", a.cookie)
	req.Header.Set("Idempotency-Key", "price-live-submit")
	response := httptest.NewRecorder()
	a.handler.ServeHTTP(response, req)
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	a.handler = app.Handler(a.pool)
	report["actual_request_write_events"] = requestEvents.Load()
	report["actual_completed_request_writes"] = completedWrites.Load()
	report["seller_price_writes"] = requestEvents.Load()
	report["mutation_http"] = response.Code
	priceEvidence(t, out, "normal-price-response.json", json.RawMessage(response.Body.Bytes()))
	if requestEvents.Load() != 1 || completedWrites.Load() != 1 || response.Code != 200 || !strings.Contains(response.Body.String(), `"succeeded":true`) {
		t.Fatalf("price response HTTP %d; no retry permitted", response.Code)
	}
	var state string
	var responseStatus int
	var responseBody []byte
	if a.fixture.QueryRow(context.Background(), `SELECT state,response_status,response_body FROM seller_upstream_writes WHERE org_id=$1 AND store_id=$2`, a.org, a.storePK).Scan(&state, &responseStatus, &responseBody) != nil || state != "settled" || responseStatus != 200 {
		t.Fatal("normal durable price receipt missing")
	}
	priceEvidence(t, out, "price-ledger-snapshot.json", map[string]any{"state": state, "response_status": responseStatus, "response_body": json.RawMessage(responseBody), "operation_id": operation, "org_id": a.org, "store_id": a.store, "store_pk": a.storePK, "credential_revision": revision})
	// Acknowledgement alone is insufficient: only read the same offer until its price agrees.
	var after priceProduct
	for attempt := 0; attempt < 12; attempt++ {
		after, raw = priceReadback(t, reader)
		priceEvidence(t, out, "price-after.json", json.RawMessage(raw))
		if after.Price == "62.01" && after.Currency == "CNY" {
			break
		}
		if attempt == 11 {
			t.Fatal("price not visible in bounded readback; do not write again")
		}
		time.Sleep(5 * time.Second)
	}
	if after.Stocks.HasStock || after.OldPrice != "" && after.OldPrice != "0" && after.OldPrice != "0.00" {
		t.Fatal("unexpected stock/strike-through readback")
	}
	report["after"] = map[string]any{"price": after.Price, "currency": after.Currency, "old_price": after.OldPrice, "has_stock": after.Stocks.HasStock}
	report["ledger_state"] = state
	report["result_boundary"] = "One normal-app price update and independent official current-price readback passed; no complete profit/fee/FX model, no production deployment, no claim of realized net margin"
	report["passed"] = true
}

type priceProduct struct {
	ID       int64  `json:"id"`
	Offer    string `json:"offer_id"`
	Price    string `json:"price"`
	OldPrice string `json:"old_price"`
	Currency string `json:"currency_code"`
	Stocks   struct {
		HasStock bool `json:"has_stock"`
	} `json:"stocks"`
}

func priceReadback(t *testing.T, reader sellercontract.Transport) (priceProduct, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	body, _ := json.Marshal(map[string]any{"offer_id": []string{priceLiveOffer}})
	status, raw, err := reader.Read(ctx, "/v3/product/info/list", body)
	got, ok := parsePriceReadback([]byte(raw))
	if err != nil || status != 200 || !ok {
		t.Fatal("official exact-offer readback unavailable")
	}
	return got, []byte(raw)
}

func parsePriceReadback(raw []byte) (priceProduct, bool) {
	var envelope struct {
		Items []json.RawMessage `json:"items"`
	}
	var got priceProduct
	if json.Unmarshal(raw, &envelope) != nil || len(envelope.Items) != 1 || json.Unmarshal(envelope.Items[0], &got) != nil || got.ID != priceLiveProduct || got.Offer != priceLiveOffer {
		return got, false
	}
	var item map[string]json.RawMessage
	var stocks map[string]json.RawMessage
	var old *string
	var has *bool
	if json.Unmarshal(envelope.Items[0], &item) != nil || json.Unmarshal(item["old_price"], &old) != nil || old == nil || json.Unmarshal(item["stocks"], &stocks) != nil || json.Unmarshal(stocks["has_stock"], &has) != nil || has == nil {
		return got, false
	}
	return got, true
}

func TestPriceReadbackRequiresExplicitNoStockAndStrikePrice(t *testing.T) {
	base := `{"items":[{"id":6706622142,"offer_id":"podhub-live-validation-f8c58027486c4ad9bd6dbdfd","price":"62.00","old_price":"","currency_code":"CNY","stocks":{"has_stock":false}}]}`
	if _, ok := parsePriceReadback([]byte(base)); !ok {
		t.Fatal("explicit empty/false rejected")
	}
	for _, bad := range []string{
		strings.Replace(base, `"old_price":"",`, "", 1), strings.Replace(base, `"old_price":""`, `"old_price":null`, 1), strings.Replace(base, `"has_stock":false`, `"other":false`, 1), strings.Replace(base, `"has_stock":false`, `"has_stock":null`, 1), strings.Replace(base, `"stocks":{"has_stock":false}`, `"stocks":null`, 1),
	} {
		if _, ok := parsePriceReadback([]byte(bad)); ok {
			t.Fatal("missing/null accepted as safe zero stock/old price")
		}
	}
}

func priceEvidence(t *testing.T, directory, name string, value any) {
	t.Helper()
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal("evidence encoding failed")
	}
	if os.MkdirAll(directory, 0700) != nil || os.WriteFile(filepath.Join(directory, name), append(raw, '\n'), 0600) != nil {
		t.Fatal("evidence save failed")
	}
}
