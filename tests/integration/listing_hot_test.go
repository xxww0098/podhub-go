package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	listing "github.com/xxww0098/podhub-go/internal/listing/core/contract"
	"github.com/xxww0098/podhub-go/internal/listing/submit"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/seller"
)

func TestListingHotPath(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	engine, err := listing.OpenEmbedded(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close(context.Background()) })

	owner, orgA := insertWorkspace(t, ctx, pool, "hot-a@example.com", "Hot A")
	other, orgB := insertWorkspace(t, ctx, pool, "hot-b@example.com", "Hot B")
	quotaUser, _ := insertWorkspace(t, ctx, pool, "hot-q@example.com", "Hot Q")
	memberA := insertMember(t, ctx, pool, orgA, owner, "owner", 1)
	insertMember(t, ctx, pool, orgA, quotaUser, "member", 2)
	insertMember(t, ctx, pool, orgB, other, "owner", 1)
	_ = memberA

	const (
		storeA = "a1111111-1111-4111-8111-111111111111"
		storeB = "a2222222-2222-4222-8222-222222222222"
		storeC = "a3333333-3333-4333-8333-333333333333"
		rowA   = "b1111111-1111-4111-8111-111111111111"
		rowB   = "b2222222-2222-4222-8222-222222222222"
		cardA  = "c1111111-1111-4111-8111-111111111111"
		jobOK  = "f1111111-1111-4111-8111-111111111111"
		jobQ   = "f2222222-2222-4222-8222-222222222222"
		jobB   = "f3333333-3333-4333-8333-333333333333"
	)
	insertStoreN(t, ctx, pool, orgA, storeA, 1)
	insertStoreN(t, ctx, pool, orgA, storeB, 2)
	insertStoreN(t, ctx, pool, orgA, storeC, 3)
	insertCard(t, ctx, pool, cardA, orgA, "卡", "2026-08-21 17:30:00+00", `{}`)
	insertListingRow(t, ctx, pool, rowA, orgA, cardA)
	insertListingRow(t, ctx, pool, rowB, orgA, cardA)
	insertBrowserJob(t, ctx, pool, jobOK, orgA, owner, rowA, "queued")
	insertBrowserJob(t, ctx, pool, jobQ, orgA, quotaUser, rowA, "queued")
	insertBrowserJob(t, ctx, pool, jobB, orgB, other, rowA, "queued")
	if _, err := pool.Exec(ctx, `
		INSERT INTO execution_quota (class, user_id, hard_limit)
		VALUES ('ai_ocr', $1, 0)
		ON CONFLICT (class, user_id) DO UPDATE SET hard_limit = 0`, quotaUser); err != nil {
		t.Fatal(err)
	}

	kek := seal.DeriveKEK("hot-path-key")
	ring := seal.Ring{Primary: kek}
	sealed, err := seal.SealV1(kek, "k1", "client-hot", "api-hot")
	if err != nil {
		t.Fatal(err)
	}
	var storePK int64
	if err := pool.QueryRow(ctx, `SELECT id FROM organization_stores WHERE uuid = $1::uuid`, storeA).Scan(&storePK); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO store_seller_credentials
		    (store_id, org_id, credential_revision, client_id, key_id, nonce, ciphertext,
		     key_fingerprint, registered_by_user_id, registered_at_ms, envelope_version)
		VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, 1)`,
		storePK, orgA, sealed.ClientID, sealed.KeyID, sealed.Nonce, sealed.Ciphertext,
		sealed.Fingerprint, owner, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	var storeBPK int64
	if err := pool.QueryRow(ctx, `SELECT id FROM organization_stores WHERE uuid = $1::uuid`, storeB).Scan(&storeBPK); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO store_seller_credentials
		    (store_id, org_id, credential_revision, client_id, key_id, nonce, ciphertext,
		     key_fingerprint, registered_by_user_id, registered_at_ms, envelope_version, key_expires_at_ms)
		VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, 1, 1)`,
		storeBPK, orgA, sealed.ClientID, sealed.KeyID, sealed.Nonce, sealed.Ciphertext,
		sealed.Fingerprint, owner, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}

	now := func() time.Time { return time.Now().UTC() }
	var posts []string
	sellerFn := func(_ context.Context, path string, body []byte, clientID, apiKey string) (int, []byte, error) {
		posts = append(posts, path+" "+clientID+" "+apiKey+" "+string(body))
		switch path {
		case "/v3/product/info/list":
			var req struct {
				OfferID []string `json:"offer_id"`
			}
			if json.Unmarshal(body, &req) != nil || len(req.OfferID) != 1 {
				t.Fatalf("probe body %s", body)
			}
			if clientID != "client-hot" || apiKey != "api-hot" {
				t.Fatalf("headers %s %s", clientID, apiKey)
			}
			switch req.OfferID[0] {
			case "OFFER-FOUND":
				return 200, []byte(`{"items":[{"id":9,"offer_id":"OFFER-FOUND","sources":[{"sku":0},{"sku":42}]}]}`), nil
			case "OFFER-ABSENT":
				return 200, []byte(`{"items":[]}`), nil
			default:
				return 500, []byte(`nope`), nil
			}
		case "/v1/description-category/tree":
			if strings.Contains(string(body), "fail-tree") {
				return 500, []byte(`nope`), nil
			}
			return 200, []byte(`{"result":[{"description_category_id":9,"category_name":"类","disabled":false,"children":[{"description_category_id":0,"category_name":"","type_id":8,"type_name":"型","disabled":false}]}]}`), nil
		case "/v1/description-category/attribute":
			if strings.Contains(string(body), `"type_id":88002`) {
				return 500, []byte(`nope`), nil
			}
			return 200, []byte(`{"result":[]}`), nil
		default:
			t.Fatalf("unexpected seller %s %s", path, body)
			return 500, nil, nil
		}
	}
	ownerH := hotHandler(pool, engine, access.Principal{UserID: owner, OrgID: orgA, WorkspaceRole: "owner", PlatformRole: "user"}, now, sellerFn, ring)
	otherH := hotHandler(pool, engine, access.Principal{UserID: other, OrgID: orgB, WorkspaceRole: "owner", PlatformRole: "user"}, now, sellerFn, ring)

	claim := callJSON(ownerH, http.MethodPost, "/api/listing/jobs/"+jobOK+"/claim", "")
	if claim.Code != http.StatusOK || !strings.Contains(claim.Body.String(), `"leaseSeconds":30`) || !strings.Contains(claim.Body.String(), jobOK) {
		t.Fatalf("claim %d %s", claim.Code, claim.Body.String())
	}
	var claimed struct {
		Data struct {
			Lease struct {
				Owner string `json:"owner"`
				Epoch int64  `json:"epoch"`
			} `json:"lease"`
		} `json:"data"`
	}
	if err := json.Unmarshal(claim.Body.Bytes(), &claimed); err != nil || claimed.Data.Lease.Owner == "" || claimed.Data.Lease.Epoch == 0 {
		t.Fatalf("lease %s %v", claim.Body.String(), err)
	}
	again := callJSON(ownerH, http.MethodPost, "/api/listing/jobs/"+jobOK+"/claim", "")
	if again.Code != http.StatusOK || !strings.Contains(again.Body.String(), `"data":null`) {
		t.Fatalf("second claim %d %s", again.Code, again.Body.String())
	}
	beatBody := `{"owner":"` + claimed.Data.Lease.Owner + `","epoch":` + epochText(claimed.Data.Lease.Epoch) + `}`
	beat := callJSON(ownerH, http.MethodPost, "/api/listing/jobs/"+jobOK+"/heartbeat", beatBody)
	if beat.Code != http.StatusOK || beat.Body.String() != `{"data":true}` {
		t.Fatalf("heartbeat %d %s", beat.Code, beat.Body.String())
	}
	miss := callJSON(ownerH, http.MethodPost, "/api/listing/jobs/"+jobOK+"/heartbeat", `{"owner":"nope","epoch":1}`)
	if miss.Code != http.StatusOK || miss.Body.String() != `{"data":false}` {
		t.Fatalf("heartbeat miss %d %s", miss.Code, miss.Body.String())
	}
	if callJSON(ownerH, http.MethodPost, "/api/listing/jobs/"+jobOK+"/heartbeat", `{}`).Code != http.StatusBadRequest {
		t.Fatal("heartbeat body")
	}
	badID := callJSON(ownerH, http.MethodPost, "/api/listing/jobs/not-a-uuid/claim", "")
	if badID.Code != http.StatusInternalServerError || !strings.Contains(badID.Body.String(), "服务暂不可用") {
		t.Fatalf("bad id %d %s", badID.Code, badID.Body.String())
	}
	cross := callJSON(otherH, http.MethodPost, "/api/listing/jobs/"+jobOK+"/claim", "")
	if cross.Code != http.StatusOK || !strings.Contains(cross.Body.String(), `"data":null`) {
		t.Fatalf("cross claim %d %s", cross.Code, cross.Body.String())
	}
	if callJSON(ownerH, http.MethodPost, "/api/listing/jobs/claim-window", `{}`).Code != http.StatusBadRequest {
		t.Fatal("window empty")
	}
	media := callJSON(ownerH, http.MethodPost, "/api/listing/jobs/claim-window", `{"jobIds":["`+jobQ+`"],"kind":"media.render","limit":4}`)
	if media.Code != http.StatusOK || !strings.Contains(media.Body.String(), `"data":[]`) {
		t.Fatalf("window media %d %s", media.Code, media.Body.String())
	}
	quota := callJSON(ownerH, http.MethodPost, "/api/listing/jobs/"+jobQ+"/claim", "")
	if quota.Code != http.StatusTooManyRequests || !strings.Contains(quota.Body.String(), "当前用户的执行配额已用尽") || quota.Header().Get("Retry-After") != "5" {
		t.Fatalf("quota %d %s %s", quota.Code, quota.Header().Get("Retry-After"), quota.Body.String())
	}
	var still string
	if err := pool.QueryRow(ctx, `SELECT state FROM jobs WHERE id = $1::uuid`, jobQ).Scan(&still); err != nil || still != "queued" {
		t.Fatalf("quota rolled back %s %v", still, err)
	}
	windowQuota := callJSON(ownerH, http.MethodPost, "/api/listing/jobs/claim-window", `{"jobIds":["`+jobQ+`"],"kind":"ai.recognize","limit":4}`)
	if windowQuota.Code != http.StatusOK || !strings.Contains(windowQuota.Body.String(), `"data":[]`) {
		t.Fatalf("window quota %d %s", windowQuota.Code, windowQuota.Body.String())
	}

	bare, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer bare.Release()
	guc, err := bare.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = guc.Rollback(ctx) }()
	if _, err := guc.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	var seen int64
	if err := guc.QueryRow(ctx, `SELECT count(*) FROM jobs`).Scan(&seen); err != nil || seen != 0 {
		t.Fatalf("missing GUC sees jobs %d %v", seen, err)
	}
	if _, err := guc.Exec(ctx, `UPDATE jobs SET attempt = attempt WHERE id = $1::uuid`, jobOK); err == nil {
		var n int64
		if err := guc.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE id = $1::uuid`, jobOK).Scan(&n); err != nil || n != 0 {
			t.Fatalf("missing GUC touched a job %d %v", n, err)
		}
	}
	hidden, err := tenant.BeginApp(ctx, pool.Begin, orgB)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = hidden.Rollback(ctx) }()
	if err := hidden.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE id = $1::uuid`, jobOK).Scan(&seen); err != nil || seen != 0 {
		t.Fatalf("cross org sees job %d %v", seen, err)
	}

	if _, err := pool.Exec(ctx, `UPDATE listing_rows SET revision = 4 WHERE id = $1::uuid`, rowB); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE listing_rows SET submission_state = 'queued' WHERE id = $1::uuid`, rowA); err != nil {
		t.Fatal(err)
	}
	probeHot(t, ctx, pool, ownerH, otherH, orgA, storeA, rowB)
	catalogHot(t, ctx, pool, ownerH, kek, access.Principal{UserID: owner, OrgID: orgA, WorkspaceRole: "owner", PlatformRole: "user"}, engine)
	cardHot(t, ctx, pool, ownerH, orgA)
	if _, err := pool.Exec(ctx, `
		UPDATE listing_cards
		SET payload = '{"descriptionCategoryId":9,"typeId":8,"language":"default"}'::jsonb
		WHERE id = $1::uuid`, cardA); err != nil {
		t.Fatal(err)
	}
	rowHot(t, ownerH, rowA)
	// Probe left an unknown intent with a null offer on store A. That row
	// fences every new queued offer on the store, so requeue uses store B.
	requeueHot(t, ctx, pool, orgA, storeB, rowB)
}

func probeHot(t *testing.T, ctx context.Context, pool *pgxpool.Pool, ownerH, otherH http.Handler, org int64, store, row string) {
	t.Helper()
	const (
		found  = "d1111111-1111-4111-8111-111111111111"
		absent = "d2222222-2222-4222-8222-222222222222"
		bad    = "d3333333-3333-4333-8333-333333333333"
		busy   = "d4444444-4444-4444-8444-444444444444"
		none   = "d5555555-5555-4555-8555-555555555555"
	)
	insertIntent(t, ctx, pool, found, org, store, row, "unknown", "op-f", strPtr("OZON_RECONCILE_STILL_UNKNOWN"), strPtr("OFFER-FOUND"))
	insertIntent(t, ctx, pool, absent, org, store, row, "unknown", "op-a", strPtr("OZON_RECONCILE_STILL_UNKNOWN"), strPtr("OFFER-ABSENT"))
	insertIntent(t, ctx, pool, bad, org, store, row, "unknown", "op-b", strPtr("OZON_RECONCILE_STILL_UNKNOWN"), strPtr("OFFER-BAD"))
	insertIntent(t, ctx, pool, busy, org, store, row, "unknown", "op-z", strPtr("OZON_RECONCILE_STILL_UNKNOWN"), strPtr("OFFER-BUSY"))
	insertIntent(t, ctx, pool, none, org, store, row, "unknown", "op-n", strPtr("OZON_RECONCILE_STILL_UNKNOWN"), nil)
	if _, err := pool.Exec(ctx, `UPDATE submission_intents SET reconcile_claim_until = clock_timestamp() + interval '5 minutes' WHERE id = $1::uuid`, busy); err != nil {
		t.Fatal(err)
	}
	got := callJSON(ownerH, http.MethodPost, "/api/listing/intents/"+found+"/probe", "")
	if got.Code != http.StatusOK || !strings.Contains(got.Body.String(), `"state":"accepted"`) || !strings.Contains(got.Body.String(), `"sku":42`) {
		t.Fatalf("found %d %s", got.Code, got.Body.String())
	}
	var rowState string
	if err := pool.QueryRow(ctx, `SELECT submission_state FROM listing_rows WHERE id = $1::uuid`, row).Scan(&rowState); err != nil || rowState != "accepted" {
		t.Fatalf("row accepted %s %v", rowState, err)
	}
	first := callJSON(ownerH, http.MethodPost, "/api/listing/intents/"+absent+"/probe", "")
	if first.Code != http.StatusOK || !strings.Contains(first.Body.String(), `"state":"unknown"`) {
		t.Fatalf("absent1 %d %s", first.Code, first.Body.String())
	}
	second := callJSON(ownerH, http.MethodPost, "/api/listing/intents/"+absent+"/probe", "")
	if second.Code != http.StatusOK || !strings.Contains(second.Body.String(), `"state":"superseded"`) {
		t.Fatalf("absent2 %d %s", second.Code, second.Body.String())
	}
	if err := pool.QueryRow(ctx, `SELECT submission_state FROM listing_rows WHERE id = $1::uuid`, row).Scan(&rowState); err != nil || rowState != "none" {
		t.Fatalf("row none %s %v", rowState, err)
	}
	unread := callJSON(ownerH, http.MethodPost, "/api/listing/intents/"+bad+"/probe", "")
	if unread.Code != http.StatusOK || !strings.Contains(unread.Body.String(), `"state":"unknown"`) {
		t.Fatalf("unread %d %s", unread.Code, unread.Body.String())
	}
	var claim *time.Time
	if err := pool.QueryRow(ctx, `SELECT reconcile_claim_until FROM submission_intents WHERE id = $1::uuid`, bad).Scan(&claim); err != nil || claim != nil {
		t.Fatalf("claim left %v %v", claim, err)
	}
	stopped := callJSON(ownerH, http.MethodPost, "/api/listing/intents/"+found+"/probe", "")
	if stopped.Code != http.StatusConflict || !strings.Contains(stopped.Body.String(), "只有自动核对停止后才能按货号再核对") {
		t.Fatalf("stopped %d %s", stopped.Code, stopped.Body.String())
	}
	noOffer := callJSON(ownerH, http.MethodPost, "/api/listing/intents/"+none+"/probe", "")
	if noOffer.Code != http.StatusConflict || !strings.Contains(noOffer.Body.String(), "没有货号") {
		t.Fatalf("no offer %d %s", noOffer.Code, noOffer.Body.String())
	}
	held := callJSON(ownerH, http.MethodPost, "/api/listing/intents/"+busy+"/probe", "")
	if held.Code != http.StatusConflict || !strings.Contains(held.Body.String(), "正在按货号核对") {
		t.Fatalf("busy %d %s", held.Code, held.Body.String())
	}
	cross := callJSON(otherH, http.MethodPost, "/api/listing/intents/"+found+"/probe", "")
	if cross.Code != http.StatusNotFound || !strings.Contains(cross.Body.String(), "提交意图不存在") {
		t.Fatalf("cross probe %d %s", cross.Code, cross.Body.String())
	}
}

func catalogHot(t *testing.T, ctx context.Context, pool *pgxpool.Pool, ownerH http.Handler, kek []byte, principal access.Principal, engine listing.Engine) {
	t.Helper()
	if _, err := pool.Exec(ctx, `DELETE FROM ozon_catalog_tree_cache WHERE language = 'default'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM platform_catalog_fetch_keys WHERE client_id = 'hot-client'`)
		_, _ = pool.Exec(context.Background(), `DELETE FROM ozon_catalog_tree_cache WHERE language = 'default'`)
		_, _ = pool.Exec(context.Background(), `DELETE FROM ozon_catalog_schema_cache WHERE description_category_id IN (88001, 88002)`)
	})
	miss := callJSON(ownerH, http.MethodGet, "/api/catalog/tree?language=default&store_id=a3333333-3333-4333-8333-333333333333", "")
	if miss.Code != http.StatusBadRequest || !strings.Contains(miss.Body.String(), "该店铺尚未登记 Seller 密钥") {
		t.Fatalf("no key %d %s", miss.Code, miss.Body.String())
	}
	expired := callJSON(ownerH, http.MethodGet, "/api/catalog/tree?language=default&store_id=a2222222-2222-4222-8222-222222222222", "")
	if expired.Code != http.StatusBadRequest || !strings.Contains(expired.Body.String(), "该店铺 Seller 密钥已过期") {
		t.Fatalf("expired %d %s", expired.Code, expired.Body.String())
	}
	tree := callJSON(ownerH, http.MethodGet, "/api/catalog/tree?language=default&store_id=a1111111-1111-4111-8111-111111111111", "")
	if tree.Code != http.StatusOK || !strings.Contains(tree.Body.String(), `"category_name":"类"`) || !strings.Contains(tree.Body.String(), `"type_name":"型"`) {
		t.Fatalf("tree %d %s", tree.Code, tree.Body.String())
	}
	var cached int64
	if err := pool.QueryRow(ctx, `SELECT fetched_at_ms FROM ozon_catalog_tree_cache WHERE language = 'default'`).Scan(&cached); err != nil || cached == 0 {
		t.Fatalf("tree cache %d %v", cached, err)
	}

	nonce, ct, err := seal.SealBlob(kek, "hot-key", []byte("api-hot"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO platform_catalog_fetch_config (singleton, updated_at_ms)
		VALUES (true, 0) ON CONFLICT (singleton) DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO platform_catalog_fetch_keys
		    (config_singleton, position, client_id, api_key_key_id, api_key_nonce, api_key_ciphertext)
		VALUES (true, 8, 'hot-client', 'hot-key', $1, $2)`, nonce, ct); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM ozon_catalog_tree_cache WHERE language = 'default'`); err != nil {
		t.Fatal(err)
	}
	schema := callJSON(ownerH, http.MethodGet, "/api/catalog/schema?description_category_id=88001&type_id=88001&language=default", "")
	if schema.Code != http.StatusOK || !strings.Contains(schema.Body.String(), `"native_material"`) || !strings.Contains(schema.Body.String(), `"schema_revision"`) {
		t.Fatalf("schema live %d %s", schema.Code, schema.Body.String())
	}
	fail := callJSON(ownerH, http.MethodGet, "/api/catalog/schema?description_category_id=88002&type_id=88002&language=default", "")
	if fail.Code != http.StatusBadGateway || !strings.Contains(fail.Body.String(), "平台类目读取失败，请检查平台类目密钥后重试") {
		t.Fatalf("schema fail %d %s", fail.Code, fail.Body.String())
	}
	again := callJSON(ownerH, http.MethodGet, "/api/catalog/schema?description_category_id=88002&type_id=88002&language=default", "")
	if again.Code != http.StatusBadGateway || !strings.Contains(again.Body.String(), "该类目刚刚读取失败，请一分钟后重试") {
		t.Fatalf("negative %d %s", again.Code, again.Body.String())
	}
	if _, err := pool.Exec(ctx, `DELETE FROM ozon_catalog_tree_cache WHERE language = 'en'`); err != nil {
		t.Fatal(err)
	}
	failTree := hotHandler(pool, engine, principal, time.Now, func(context.Context, string, []byte, string, string) (int, []byte, error) {
		return 500, []byte(`nope`), nil
	}, seal.Ring{Primary: kek})
	treeFail := callJSON(failTree, http.MethodGet, "/api/catalog/tree?language=en&store_id=a1111111-1111-4111-8111-111111111111", "")
	if treeFail.Code != http.StatusBadGateway || !strings.Contains(treeFail.Body.String(), "类目树读取失败，请稍后重试") {
		t.Fatalf("tree fail %d %s", treeFail.Code, treeFail.Body.String())
	}
	if _, err := pool.Exec(ctx, `DELETE FROM ozon_catalog_tree_cache WHERE language = 'ru'`); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLOUD_SELLER_BASE_URL", "https://api-seller.ozon.ru")
	eg := seller.New(config.Load())
	refused := hotHandler(pool, engine, principal, time.Now, func(ctx context.Context, path string, body []byte, clientID, apiKey string) (int, []byte, error) {
		_, err := eg.Call(ctx, http.MethodPost, path, body, false, false, clientID, apiKey)
		return 0, nil, err
	}, seal.Ring{Primary: kek})
	blocked := callJSON(refused, http.MethodGet, "/api/catalog/tree?language=ru&store_id=a1111111-1111-4111-8111-111111111111", "")
	if blocked.Code != http.StatusBadGateway || !strings.Contains(blocked.Body.String(), "Seller 服务暂时无法访问") {
		t.Fatalf("non-loopback %d %s", blocked.Code, blocked.Body.String())
	}
	if _, err := pool.Exec(ctx, `DELETE FROM ozon_catalog_tree_cache WHERE language = 'tr'`); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	busyH := hotHandler(pool, engine, principal, time.Now, func(context.Context, string, []byte, string, string) (int, []byte, error) {
		once.Do(func() { close(started) })
		<-release
		return 500, []byte(`nope`), nil
	}, seal.Ring{Primary: kek})
	go callJSON(busyH, http.MethodGet, "/api/catalog/tree?language=tr&store_id=a1111111-1111-4111-8111-111111111111", "")
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("tree fill did not reach seller")
	}
	busy := callJSON(busyH, http.MethodGet, "/api/catalog/tree?language=tr&store_id=a1111111-1111-4111-8111-111111111111", "")
	close(release)
	if busy.Code != http.StatusServiceUnavailable || busy.Header().Get("Retry-After") != "3" || !strings.Contains(busy.Body.String(), "类目数据正在读取，请稍后重试") {
		t.Fatalf("busy %d %s", busy.Code, busy.Body.String())
	}
}

func cardHot(t *testing.T, ctx context.Context, pool *pgxpool.Pool, h http.Handler, org int64) {
	t.Helper()
	now := time.Now().UnixMilli()
	digest := "sha256:" + strings.Repeat("ab", 32)
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_sources (source_id, name, listed, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ('src_hot', '热源', true, $1, $1, 'hot')`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_products (product_id, title, published, created_at_ms, updated_at_ms, created_by_account_uuid, source_id, archived)
		VALUES ('hot-sku-1', '供应商帽', true, $1, $1, 'hot', 'src_hot', false),
		       ('hot-sku-arch', '归档帽', true, $1, $1, 'hot', 'src_hot', true)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_skus (sku_id, product_id, platform_code, title, published, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ('sku-hot-1', 'hot-sku-1', 'plat-hot-1', '供应商帽', true, $1, $1, 'hot'),
		       ('sku-hot-arch', 'hot-sku-arch', 'plat-hot-arch', '归档帽', true, $1, $1, 'hot')`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO supplier_ozon_configs (
		    product_id, description_category_id, type_id, language, prompt_text, state,
		    validated_catalog_digest, created_at_ms, updated_at_ms, created_by_account_uuid, updated_by_account_uuid)
		VALUES ('hot-sku-1', 9, 8, 'default', '画一顶帽子', 'valid', $2, $1, $1, 'hot', 'hot'),
		       ('hot-sku-arch', 9, 8, 'default', '画一顶帽子', 'valid', $2, $1, $1, 'hot', 'hot')`, now, digest); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO ozon_category_current (description_category_id, type_id, language, fields, content_digest, fetched_at_ms)
		VALUES (9, 8, 'default', '[]'::jsonb, $1, $2)
		ON CONFLICT (description_category_id, type_id, language) DO UPDATE
		SET content_digest = EXCLUDED.content_digest, fetched_at_ms = EXCLUDED.fetched_at_ms`, digest, now); err != nil {
		t.Fatal(err)
	}
	created := callJSON(h, http.MethodPost, "/api/listing/cards", `{"createMode":"fromSupplier","supplierProductId":"hot-sku-1","title":"方案"}`)
	if created.Code != http.StatusOK || !strings.Contains(created.Body.String(), `"supplierProductId":"hot-sku-1"`) {
		t.Fatalf("create %d %s", created.Code, created.Body.String())
	}
	var id string
	var parsed struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	id = parsed.Data.ID
	dup := callJSON(h, http.MethodPost, "/api/listing/cards", `{"createMode":"fromSupplier","supplierProductId":"hot-sku-1"}`)
	if dup.Code != http.StatusOK || !strings.Contains(dup.Body.String(), id) {
		t.Fatalf("dup %d %s", dup.Code, dup.Body.String())
	}
	missing := callJSON(h, http.MethodPost, "/api/listing/cards", `{"createMode":"fromSupplier","supplierProductId":"missing-hot"}`)
	if missing.Code != http.StatusNotFound || !strings.Contains(missing.Body.String(), "供应商商品不存在或当前不可上架") {
		t.Fatalf("missing %d %s", missing.Code, missing.Body.String())
	}
	arch := callJSON(h, http.MethodPost, "/api/listing/cards", `{"createMode":"fromSupplier","supplierProductId":"hot-sku-arch"}`)
	if arch.Code != http.StatusConflict || !strings.Contains(arch.Body.String(), `"code":"supplier_not_listable"`) || !strings.Contains(arch.Body.String(), `"denial":"product_archived"`) {
		t.Fatalf("archived %d %s", arch.Code, arch.Body.String())
	}
	if _, err := pool.Exec(ctx, `UPDATE listing_cards SET payload = payload || '{"aiPromptSha256":"sha256:abc"}'::jsonb WHERE id = $1::uuid`, id); err != nil {
		t.Fatal(err)
	}
	got := callJSON(h, http.MethodGet, "/api/listing/cards/"+id, "")
	if got.Code != http.StatusOK || !strings.Contains(got.Body.String(), `"ocrPromptSha256":"sha256:abc"`) {
		t.Fatalf("get %d %s", got.Code, got.Body.String())
	}
	list := callJSON(h, http.MethodGet, "/api/listing/cards?limit=50", "")
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), id) || strings.Contains(list.Body.String(), "ocrPromptSha256") {
		t.Fatalf("list %d %s", list.Code, list.Body.String())
	}
	queued := callJSON(h, http.MethodPatch, "/api/listing/cards/"+id, `{"baseRevision":1,"payload":{"queue":{"paused":true,"stopAfterCurrent":false,"nextPosition":0,"frozenRowIds":[]}}}`)
	if queued.Code != http.StatusOK || !strings.Contains(queued.Body.String(), `"paused":true`) {
		t.Fatalf("queue %d %s", queued.Code, queued.Body.String())
	}
	title := callJSON(h, http.MethodPatch, "/api/listing/cards/"+id, `{"baseRevision":2,"title":"改标题"}`)
	if title.Code != http.StatusBadRequest || !strings.Contains(title.Body.String(), "供应商商品方案配置由在线平台货源管理") {
		t.Fatalf("title %d %s", title.Code, title.Body.String())
	}
	long := strings.Repeat("p", 513)
	psd := callJSON(h, http.MethodPatch, "/api/listing/cards/"+id, `{"baseRevision":2,"payload":{"psdTemplateFileName":"`+long+`"}}`)
	if psd.Code != http.StatusBadRequest || !strings.Contains(psd.Body.String(), "PSD 模板绑定过长") {
		t.Fatalf("psd %d %s", psd.Code, psd.Body.String())
	}
	plain := callJSON(h, http.MethodPatch, "/api/listing/cards/c1111111-1111-4111-8111-111111111111", `{"baseRevision":1,"payload":{"supplierProductId":"hot-sku-1","categoryKey":"workflow:9:8","descriptionCategoryId":9,"typeId":8,"language":"default","defaults":{"values":{},"complex_values":[]}}}`)
	if plain.Code != http.StatusBadRequest || !strings.Contains(plain.Body.String(), "请从平台货源选择规格创建方案") {
		t.Fatalf("plain %d %s", plain.Code, plain.Body.String())
	}
	_ = org
}

func rowHot(t *testing.T, h http.Handler, row string) {
	t.Helper()
	fill := callJSON(h, http.MethodPatch, "/api/listing/rows/"+row, `{"baseRevision":1,"fillBlank":true}`)
	if fill.Code != http.StatusOK || !strings.Contains(fill.Body.String(), `"revision":2`) || strings.Contains(fill.Body.String(), `"plan"`) {
		t.Fatalf("fillBlank %d %s", fill.Code, fill.Body.String())
	}
	merged := callJSON(h, http.MethodPatch, "/api/listing/rows/"+row, `{"baseRevision":2,"changes":{"note":"n1"}}`)
	if merged.Code != http.StatusOK || !strings.Contains(merged.Body.String(), `"note":"n1"`) {
		t.Fatalf("merge %d %s", merged.Code, merged.Body.String())
	}
	protect := callJSON(h, http.MethodPatch, "/api/listing/rows/"+row, `{"baseRevision":3,"changes":{"ai":{"x":1}}}`)
	if protect.Code != http.StatusBadRequest || !strings.Contains(protect.Body.String(), "识别证据与字段来源由服务端维护") {
		t.Fatalf("protect %d %s", protect.Code, protect.Body.String())
	}
	both := callJSON(h, http.MethodPatch, "/api/listing/rows/"+row, `{"baseRevision":3,"candidateDecisions":[{"index":0,"accept":true}],"draft":{"values":{},"complex_values":[]}}`)
	if both.Code != http.StatusBadRequest || !strings.Contains(both.Body.String(), "候选确认不能与其他字段写入一起提交") {
		t.Fatalf("decisions mix %d %s", both.Code, both.Body.String())
	}
	clear := callJSON(h, http.MethodPatch, "/api/listing/rows/"+row, `{"baseRevision":3,"clearGeneratedContent":true}`)
	if clear.Code != http.StatusUnprocessableEntity || !strings.Contains(clear.Body.String(), "已上架或待对账商品不能清空生成内容") {
		t.Fatalf("clear %d %s", clear.Code, clear.Body.String())
	}
}

func requeueHot(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, store, row string) {
	t.Helper()
	const (
		queued = "e1111111-1111-4111-8111-111111111111"
		rej    = "e2222222-2222-4222-8222-222222222222"
		gone   = "e3333333-3333-4333-8333-333333333333"
		unk    = "e4444444-4444-4444-8444-444444444444"
	)
	insertIntent(t, ctx, pool, queued, org, store, row, "queued", "op-rq", nil, strPtr("offer-rq"))
	insertIntent(t, ctx, pool, rej, org, store, row, "rejected", "op-rr", strPtr("OZON_WRITES_DISABLED"), strPtr("offer-rr"))
	insertIntent(t, ctx, pool, gone, org, store, row, "superseded", "op-rs", nil, strPtr("offer-rs"))
	insertIntent(t, ctx, pool, unk, org, store, row, "unknown", "op-ru", strPtr("OZON_RECONCILE_STILL_UNKNOWN"), strPtr("offer-ru"))
	if _, err := pool.Exec(ctx, `
		UPDATE submission_intents
		SET submission_issues = '[{"code":"OZON_WRITES_DISABLED","resolvedAtMs":null,"allowedActions":["resume"]}]'::jsonb
		WHERE id = $1::uuid`, rej); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE submission_intents
		SET reconciliation_outcome = '{"probeReleased":{"atMs":9,"passes":2}}'::jsonb
		WHERE id = $1::uuid`, gone); err != nil {
		t.Fatal(err)
	}
	tx, err := tenant.BeginApp(ctx, pool.Begin, org)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ok, err := submit.RequeueRetryable(ctx, tx, org, queued, 9, "new-hash", "op-new", "offer-new")
	if err != nil || ok {
		t.Fatalf("illegal queued requeue %v %v", ok, err)
	}
	n, err := submit.StampAcceptRows(ctx, tx, org, queued, 1, 2)
	if err != nil || n != 0 {
		t.Fatalf("illegal stamp accept %d %v", n, err)
	}
	n, err = submit.StampReleaseRows(ctx, tx, org, queued, 1, 2)
	if err != nil || n != 0 {
		t.Fatalf("illegal stamp release %d %v", n, err)
	}
	n, err = submit.StampRetryRows(ctx, tx, org, queued, 1, "absent", "OZON_RECONCILE_STILL_UNKNOWN", 0)
	if err != nil || n != 0 {
		t.Fatalf("illegal stamp retry %d %v", n, err)
	}
	ok, err = submit.RequeueRetryable(ctx, tx, org, rej, 9, "new-hash", "op-new", "offer-rr")
	if err != nil || !ok {
		t.Fatalf("rejected requeue %v %v", ok, err)
	}
	ok, err = submit.RequeueRetryable(ctx, tx, org, gone, 9, "hash", "op-rs", "offer-rs")
	if err != nil || !ok {
		t.Fatalf("superseded requeue %v %v", ok, err)
	}
	n, err = submit.StampAcceptRows(ctx, tx, org, unk, 3, 4)
	if err != nil || n != 1 {
		t.Fatalf("stamp accept %d %v", n, err)
	}
	n, err = submit.StampAcceptRows(ctx, tx, org, unk, 3, 4)
	if err != nil || n != 0 {
		t.Fatalf("second stamp %d %v", n, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var state string
	if err := pool.QueryRow(ctx, `SELECT state FROM submission_intents WHERE id = $1::uuid`, rej).Scan(&state); err != nil || state != "queued" {
		t.Fatalf("requeued %s %v", state, err)
	}
}

func hotHandler(pool *pgxpool.Pool, engine listing.Engine, p access.Principal, now func() time.Time, seller func(context.Context, string, []byte, string, string) (int, []byte, error), ring seal.Ring) http.Handler {
	router := chi.NewRouter()
	srv := &httpapi.Server{
		Pool: pool, Engine: engine, Access: access.FixedResolver{Principal: &p}, Now: now,
		Seller: seller, Seals: ring,
	}
	httpapi.HandlerFromMux(srv, router)
	httpapi.MountDomains(router, srv)
	return specChecked(router)
}

func insertStoreN(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, id string, order int64) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO organization_stores (org_id, uuid, create_order, name)
		VALUES ($1, $2::uuid, $3, 'shop')`, org, id, order)
	if err != nil {
		t.Fatal(err)
	}
}

func insertBrowserJob(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string, org, user int64, row, state string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO jobs (
			id, org_id, kind, aggregate_type, aggregate_id, input_revision, idempotency_key,
			state, attempt, max_attempts, lane, submitter_user_id, payload
		) VALUES (
			$1::uuid, $2, 'ai.recognize', 'listing_row', $3::uuid, 1, $1,
			$4, 0, 8, 'listing', $5, '{"executor":"browser"}'::jsonb
		)`, id, org, row, state, user)
	if err != nil {
		t.Fatal(err)
	}
}

func epochText(n int64) string {
	raw, _ := json.Marshal(n)
	return string(raw)
}
