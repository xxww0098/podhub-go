package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/app"
	cataloghttp "github.com/xxww0098/podhub-go/internal/catalog/http"
	"github.com/xxww0098/podhub-go/internal/identity"
	identitycontract "github.com/xxww0098/podhub-go/internal/identity/contract"
	coremod "github.com/xxww0098/podhub-go/internal/listing/core"
	coredomain "github.com/xxww0098/podhub-go/internal/listing/core/domain"
	readhttp "github.com/xxww0098/podhub-go/internal/listing/read/http"
	"github.com/xxww0098/podhub-go/internal/listing/rules"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

type listingMediaTest struct {
	t         *testing.T
	ctx       context.Context
	pool      *pgxpool.Pool
	handler   http.Handler
	cookie    string
	other     string
	workspace string
	org       int64
}

type listingMediaRow struct {
	ID             string          `json:"id"`
	Revision       int64           `json:"revision"`
	ViewRevision   int64           `json:"view_revision"`
	MediaState     string          `json:"media_state"`
	Media          json.RawMessage `json:"media"`
	RenderEvidence struct {
		Digest   string          `json:"manifest_digest"`
		Manifest json.RawMessage `json:"manifest"`
	} `json:"render_evidence"`
}

type listingMediaRun struct {
	ID            string `json:"id"`
	Kind          string `json:"kind"`
	AggregateID   string `json:"aggregate_id"`
	InputRevision int64  `json:"input_revision"`
	State         string `json:"state"`
	Payload       struct {
		ManifestDigest string `json:"manifest_digest"`
	} `json:"payload"`
}

type listingMediaPlan struct {
	Outcome string            `json:"outcome"`
	Jobs    []listingMediaRun `json:"jobs"`
}

type listingMediaReceipt struct {
	Applied      bool             `json:"applied"`
	Index        int              `json:"index"`
	Completed    int              `json:"completed"`
	Total        int              `json:"total"`
	MediaState   string           `json:"media_state"`
	ViewRevision int64            `json:"view_revision"`
	PublicURL    string           `json:"public_url"`
	Row          *listingMediaRow `json:"row"`
}

func listingMediaData[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("HTTP %d: %s", rec.Code, rec.Body.String())
	}
	var envelope struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Data
}

func (f listingMediaTest) post(path, cookie string, body any) *httptest.ResponseRecorder {
	f.t.Helper()
	raw := []byte{}
	if body != nil {
		var err error
		raw, err = json.Marshal(body)
		if err != nil {
			f.t.Fatal(err)
		}
	}
	return postJSON(f.t, f.handler, path, string(raw), "", cookie)
}

func (f listingMediaTest) newRow() (listingMediaRow, string) {
	f.t.Helper()
	card := listingMediaData[struct {
		ID string `json:"id"`
	}](f.t, f.post("/api/listing/cards", f.cookie, map[string]any{
		"title": "Media integration", "createMode": "blank", "payload": map[string]any{
			"categoryKey": "media-fixture", "descriptionCategoryId": 17027906, "typeId": 91976,
			"defaults":           map[string]any{"values": map[string]any{}, "complex_values": []any{}},
			"psdTemplateAssetId": strings.Repeat("1", 64), "psdTemplateSha256": strings.Repeat("1", 64), "psdTemplateFileName": "template.psd",
			"aiFieldPolicy": map[string]any{"allowed_field_keys": []string{}, "protected_field_keys": []string{}},
		},
	}))
	row := listingMediaData[listingMediaRow](f.t, f.post("/api/listing/rows", f.cookie, map[string]any{
		"cardId": card.ID, "source": map[string]string{"sha256": strings.Repeat("a", 64), "fileName": "source.png"},
		"draft": map[string]any{"values": map[string]any{}, "complex_values": []any{}},
	}))
	if row.ID == "" || row.Revision != 1 {
		f.t.Fatalf("invalid created row %+v", row)
	}
	return row, card.ID
}

func (f listingMediaTest) plan(row, operation, command string) listingMediaRun {
	f.t.Helper()
	plan := listingMediaData[listingMediaPlan](f.t, f.post("/api/listing/rows/"+row+"/prepare", f.cookie,
		map[string]any{"operation": operation, "renderer_contract_version": "browser-wasm-v2", "command_id": command}))
	if len(plan.Jobs) != 1 || plan.Jobs[0].ID == "" || plan.Jobs[0].AggregateID != row {
		f.t.Fatalf("invalid plan %+v", plan)
	}
	return plan.Jobs[0]
}

func listingRenderBody(row listingMediaRow, job listingMediaRun, count int) map[string]any {
	images, slices := make([]any, count), make([]any, count)
	for i := 0; i < count; i++ {
		sum := sha256.Sum256([]byte(fmt.Sprintf("%s-image-%d", row.ID, i)))
		digest, name := "sha256:"+hex.EncodeToString(sum[:]), fmt.Sprintf("image-%d.png", i)
		images[i] = map[string]any{"index": i, "file_name": name, "content_hash": digest, "group_name": "main", "width": 8, "height": 6, "byte_size": 64, "phase": "rendered"}
		slices[i] = map[string]any{"index": i, "fileName": name, "contentHash": digest, "groupName": "main", "width": 8, "height": 6}
	}
	return map[string]any{"expected_revision": row.Revision, "job_id": job.ID, "media_state": "rendered", "payload": map[string]any{
		"media": map[string]any{"images": images}, "render_evidence": map[string]any{
			"source_sha256": strings.Repeat("a", 64), "template_sha256": strings.Repeat("1", 64), "renderer_contract_version": "browser-wasm-v2",
			"manifest_digest": "untrusted-browser-digest", "manifest": map[string]any{"slices": slices}, "sliceCount": count, "degradations": []string{},
		},
	}}
}

func (f listingMediaTest) rendered(count int) (listingMediaRow, string, listingMediaRun, map[string]any) {
	f.t.Helper()
	row, card := f.newRow()
	render := f.plan(row.ID, "slice", uuid.NewString())
	body := listingRenderBody(row, render, count)
	saved := listingMediaData[struct {
		Applied bool            `json:"applied"`
		Row     listingMediaRow `json:"row"`
	}](f.t, f.post("/api/listing/rows/"+row.ID+"/media", f.cookie, body))
	if !saved.Applied || saved.Row.MediaState != "rendered" || !strings.HasPrefix(saved.Row.RenderEvidence.Digest, "manifest:sha256:") {
		f.t.Fatalf("render did not commit authoritative evidence: %+v", saved)
	}
	f.jobState(render.ID, "succeeded")
	return saved.Row, card, render, body
}

func (f listingMediaTest) lease(row listingMediaRow, index int, status string) string {
	f.t.Helper()
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s-image-%d", row.ID, index)))
	digest := hex.EncodeToString(sum[:])
	key := "images/" + f.workspace + "/" + row.ID + "/" + digest + ".png"
	_, err := f.pool.Exec(f.ctx, `INSERT INTO media_object_leases
	 (workspace_uuid,content_hash,org_id,object_key,media_account_id,first_seen_at,last_hit_at,expires_at,verification_status,verified_at,public_ready_at,verified_byte_length,verified_width,verified_height,storage_revision,batch_id,public_url)
	 VALUES($1::uuid,$2,$3,$4,'test',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 day',$5,
	 CASE WHEN $5='verified' THEN clock_timestamp() END,CASE WHEN $5='verified' THEN clock_timestamp() END,64,8,6,1,$6,$7)`,
		f.workspace, digest, f.org, key, status, row.ID, "https://media.example.invalid/"+key)
	if err != nil {
		f.t.Fatal(err)
	}
	return key
}

func (f listingMediaTest) confirm(row, job string, index int, key, account string) *httptest.ResponseRecorder {
	return f.post(fmt.Sprintf("/api/listing/rows/%s/media/images/%d", row, index), f.cookie,
		map[string]any{"job_id": job, "object_key": key, "account_id": account})
}

func (f listingMediaTest) jobState(id, want string) {
	f.t.Helper()
	var state string
	if err := f.pool.QueryRow(f.ctx, `SELECT state FROM jobs WHERE id=$1::uuid`, id).Scan(&state); err != nil || state != want {
		f.t.Fatalf("job state=%q want=%q err=%v", state, want, err)
	}
}

func (f listingMediaTest) refusal(rec *httptest.ResponseRecorder, status int, code string) {
	f.t.Helper()
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || rec.Code != status || body.Code != code {
		f.t.Fatalf("wanted %d/%s got %d %s", status, code, rec.Code, rec.Body.String())
	}
}

func TestListingMediaPrepareNormalAPI(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	// Always own a throwaway database; never use the browser QA database or an external DSN.
	dsn, cleanup, err := testkit.StartPostgres(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	pool, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err = db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'listing-media-test'`); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	apiPool, err := db.Connect(ctx, config.Config{DatabaseURL: swapUser(dsn, "podhub_login_api", "listing-media-test")})
	if err != nil {
		t.Fatal(err)
	}
	defer apiPool.Close()
	var login string
	var privileged bool
	if err = apiPool.QueryRow(ctx, `SELECT current_user,rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user`).Scan(&login, &privileged); err != nil || privileged || login != "podhub_login_api" {
		t.Fatalf("API role %q privileged=%v err=%v", login, privileged, err)
	}
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	t.Setenv("CLOUD_COOKIE_SECURE", "0")
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "listing-media-test-key")
	if _, err = pool.Exec(ctx, `INSERT INTO account_users(public_id,email,password_hash,role,name,target,supplier_id,plan,created_at,updated_at)
	 VALUES('00000000-0000-4000-8000-000000009991','listing-media-owner@example.invalid','x','super_admin','Owner','/workspace','','free',clock_timestamp(),clock_timestamp());
	 UPDATE platform_initialization SET owner_account_id=(SELECT id FROM account_users WHERE email='listing-media-owner@example.invalid'),initialized_at=clock_timestamp() WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	registration := app.Handler(pool)
	register := func(name string) (cookie, workspace string, org int64) {
		email := "listing-media-" + name + "@example.invalid"
		rec := postJSON(t, registration, "/api/auth/register", `{"email":"`+email+`","password":"correct-horse","name":"Media"}`, "listing-media-register-"+name, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("registration %d %s", rec.Code, rec.Body.String())
		}
		if err := pool.QueryRow(ctx, `SELECT o.id,o.uuid::text FROM organizations o JOIN account_users u ON u.id=o.owner_user_id WHERE u.email=$1`, email).Scan(&org, &workspace); err != nil {
			t.Fatal(err)
		}
		return sessionCookie(rec), workspace, org
	}
	cookie, workspace, org := register("a")
	other, _, _ := register("b")
	seedMatchingLease(t, ctx, pool, "recipe", "listing media integration")
	core, err := coremod.OpenEmbedded(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer core.Close(context.Background())
	engine := tagsEngine(t)
	fields := []byte(`[{"key":"name","label":"name","group":"Attrs","editor":"text","required":false,"collection":false,"attribute_id":"4180","options":[]},{"key":"attribute:4191:0","label":"description","group":"Attrs","editor":"text","required":false,"collection":false,"attribute_id":"4191","options":[]},{"key":"attribute:23171:0","label":"tags","group":"Attrs","editor":"text","required":false,"collection":false,"attribute_id":"23171","options":[]}]`)
	input, _ := json.Marshal(map[string]any{"description_category_id": 17027906, "type_id": 91976, "fields": json.RawMessage(fields)})
	snapshot, err := core.Snapshot(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	var revision struct {
		Value string `json:"schema_revision"`
	}
	if err = json.Unmarshal(snapshot, &revision); err != nil || revision.Value == "" {
		t.Fatalf("schema snapshot %s err=%v", snapshot, err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO listing_schema_revisions(schema_revision,snapshot) VALUES($1,$2::jsonb)`, revision.Value, string(snapshot)); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(fields)
	if _, err = pool.Exec(ctx, `INSERT INTO ozon_category_current(description_category_id,type_id,language,fields,content_digest,fetched_at_ms,schema_revision) VALUES(17027906,91976,'default',$1::jsonb,$2,$3,$4)`, string(fields), "sha256:"+hex.EncodeToString(sum[:]), time.Now().UnixMilli(), revision.Value); err != nil {
		t.Fatal(err)
	}
	access := identity.New(apiPool)
	router := chi.NewRouter()
	router.Use(identity.CSRF, access.Middleware)
	cataloghttp.Mount(router, cataloghttp.Host{Pool: apiPool, Access: access, Snapshot: core.Snapshot})
	readHost := readhttp.Host{Pool: apiPool, Core: core, Engine: engine, Access: access,
		RecognitionModels: func(context.Context) ([]string, string, error) {
			return []string{"recognition-test-model"}, "recognition-test-model", nil
		},
		LoadRules: func(ctx context.Context) ([]readhttp.Rule, error) {
			var out []readhttp.Rule
			err := db.InTx(ctx, apiPool, db.AppRole(), func(tx pgx.Tx) error {
				var err error
				out, err = rules.LoadEnabledBannedTags(ctx, sqlc.New(tx))
				return err
			})
			return out, err
		},
		SearchTagTokens: coredomain.SearchTagTokens,
		Queue:           readhttp.MediaQueue{EnqueueOn: queuerepo.EnqueueOn},
		Transit: func(context.Context, pgx.Tx, identitycontract.Principal) (*readhttp.TransitStorage, error) {
			return &readhttp.TransitStorage{AccountID: "test", StorageRevision: 1, PublicURL: func(key string) string { return "https://media.example.invalid/" + key }}, nil
		},
	}
	readhttp.Mount(router, readHost)
	f := listingMediaTest{t: t, ctx: ctx, pool: pool, handler: router, cookie: cookie, other: other, workspace: workspace, org: org}

	runListingRecognitionCases(t, f, apiPool, router, readHost, access)

	t.Run("delete_row_checks_workspace_and_active_work", func(t *testing.T) {
		f := f
		f.t = t
		row, _ := f.newRow()
		remove := func(cookie string) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodDelete, "/api/listing/rows/"+row.ID, nil)
			req.Header.Set("Cookie", cookie)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			return rec
		}
		f.refusal(remove(other), 404, "not_found")
		job := f.plan(row.ID, "slice", uuid.NewString())
		f.refusal(remove(cookie), 409, "conflict")
		listingMediaData[listingMediaPlan](t, f.post("/api/listing/rows/"+row.ID+"/prepare/cancel", cookie, nil))
		if got := remove(cookie); got.Code != 200 {
			t.Fatalf("delete %d %s", got.Code, got.Body.String())
		}
		f.refusal(get(t, router, "/api/listing/rows/"+row.ID, cookie), 404, "not_found")
		f.jobState(job.ID, "cancelled")
	})

	t.Run("catalog_schema_key_disabled_during_fill_returns_bare_null", func(t *testing.T) {
		const path = "/api/catalog/schema?description_category_id=99102513&type_id=99102514&language=ru"
		miss := get(t, router, path, cookie)
		if miss.Code != 200 || strings.TrimSpace(miss.Body.String()) != "null" {
			t.Fatalf("schema miss %d %s", miss.Code, miss.Body.String())
		}
		if _, err := pool.Exec(ctx, `INSERT INTO platform_catalog_fetch_config(singleton,updated_at_ms) VALUES(true,0) ON CONFLICT(singleton) DO NOTHING`); err != nil {
			t.Fatal(err)
		}
		var keyID int64
		if err := pool.QueryRow(ctx, `INSERT INTO platform_catalog_fetch_keys(position,client_id,api_key_nonce,api_key_ciphertext) VALUES(1,'disabled-before-read',decode('00','hex'),decode('00','hex')) RETURNING id`).Scan(&keyID); err != nil {
			t.Fatal(err)
		}
		defer pool.Exec(ctx, `DELETE FROM platform_catalog_fetch_keys WHERE id=$1`, keyID)
		blocker, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer blocker.Rollback(ctx)
		if _, err = blocker.Exec(ctx, `LOCK TABLE ozon_catalog_tree_cache IN ACCESS EXCLUSIVE MODE`); err != nil {
			t.Fatal(err)
		}
		response := make(chan *httptest.ResponseRecorder, 1)
		go func() { response <- get(t, router, path, cookie) }()
		// The schema route has observed a usable key and is now inside live
		// fill. Pause its tree read while the operator disables that key.
		waiting := false
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if err = pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='podhub_login_api' AND wait_event_type='Lock' AND query LIKE '%SELECT payload FROM public.ozon_catalog_tree_cache%')`).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			if waiting {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
		if !waiting {
			t.Fatal("normal-role live fill did not reach the blocked tree read")
		}
		if _, err = pool.Exec(ctx, `UPDATE platform_catalog_fetch_keys SET disabled_at_ms=1 WHERE id=$1`, keyID); err != nil {
			t.Fatal(err)
		}
		if err = blocker.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		select {
		case rec := <-response:
			if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != "null" {
				t.Fatalf("key disappeared during live fill: %d %s", rec.Code, rec.Body.String())
			}
		case <-time.After(5 * time.Second):
			t.Fatal("schema fill did not finish after its key was disabled")
		}
	})

	t.Run("catalog_tree_credentials_use_normal_tenant_role", func(t *testing.T) {
		var storeID, actor int64
		var storeUUID string
		if err := pool.QueryRow(ctx, `SELECT owner_user_id FROM organizations WHERE id=$1`, org).Scan(&actor); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `INSERT INTO organization_stores(org_id,create_order,name) VALUES($1,1,'Catalog test') RETURNING id,uuid::text`, org).Scan(&storeID, &storeUUID); err != nil {
			t.Fatal(err)
		}
		defer pool.Exec(ctx, `DELETE FROM organization_stores WHERE id=$1`, storeID)
		kek := seal.DeriveKEK("catalog-recognition-test")
		sealed, err := seal.SealV1(kek, "test", "catalog-client", "catalog-secret")
		if err != nil {
			t.Fatal(err)
		}
		calls := 0
		local := chi.NewRouter()
		local.Use(identity.CSRF, access.Middleware)
		cataloghttp.Mount(local, cataloghttp.Host{Pool: apiPool, Access: access, Seals: seal.Ring{Primary: kek}, Seller: func(_ context.Context, path string, _ []byte, client, key string) (int, []byte, error) {
			calls++
			if path != "/v1/description-category/tree" || client != "catalog-client" || key != "catalog-secret" {
				t.Fatal("catalog seller input mismatch")
			}
			return 200, []byte(`{"result":[{"description_category_id":2,"category_name":"role fixture","disabled":false,"children":[]}]}`), nil
		}})
		path := "/api/catalog/tree?language=en&store_id=" + storeUUID
		missing := get(t, local, path, cookie)
		if missing.Code != 400 || !strings.Contains(missing.Body.String(), "尚未登记") || calls != 0 {
			t.Fatalf("missing credential %d %s calls=%d", missing.Code, missing.Body.String(), calls)
		}
		if _, err = pool.Exec(ctx, `INSERT INTO store_seller_credentials(store_id,org_id,credential_revision,client_id,key_id,nonce,ciphertext,key_fingerprint,registered_by_user_id,registered_at_ms,envelope_version) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,1,1)`, storeID, org, sealed.ClientID, sealed.KeyID, sealed.Nonce, sealed.Ciphertext, sealed.Fingerprint, actor); err != nil {
			t.Fatal(err)
		}
		otherRead := get(t, local, path, other)
		if otherRead.Code != 404 || calls != 0 {
			t.Fatalf("cross-tenant credential %d %s calls=%d", otherRead.Code, otherRead.Body.String(), calls)
		}
		live := get(t, local, path, cookie)
		if live.Code != 200 || !strings.Contains(live.Body.String(), "role fixture") || calls != 1 {
			t.Fatalf("live credential %d %s calls=%d", live.Code, live.Body.String(), calls)
		}
		cached := get(t, local, "/api/catalog/tree?language=en", cookie)
		if cached.Code != 200 || !strings.Contains(cached.Body.String(), "role fixture") || calls != 1 {
			t.Fatalf("live cache not persisted %d %s calls=%d", cached.Code, cached.Body.String(), calls)
		}
		if _, err = pool.Exec(ctx, `DELETE FROM ozon_catalog_tree_cache WHERE language='en'`); err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `UPDATE store_seller_credentials SET ciphertext=decode(repeat('00',32),'hex') WHERE store_id=$1`, storeID); err != nil {
			t.Fatal(err)
		}
		invalid := get(t, local, path, cookie)
		if invalid.Code != 400 || !strings.Contains(invalid.Body.String(), "Seller 密钥无效") || calls != 1 {
			t.Fatalf("invalid credential %d %s calls=%d", invalid.Code, invalid.Body.String(), calls)
		}
	})
	t.Run("catalog_tree_cache_uses_normal_application_role", func(t *testing.T) {
		insertTree(t, ctx, pool, time.Now().UnixMilli())
		rec := get(t, router, "/api/catalog/tree?language=zh_hans", cookie)
		if rec.Code != 200 || !bytes.Contains(rec.Body.Bytes(), []byte(`"category_name":"a"`)) {
			t.Fatalf("catalog cache read %d %s", rec.Code, rec.Body.String())
		}
		if _, err := pool.Exec(ctx, `UPDATE ozon_catalog_tree_cache SET fetched_at_ms=1 WHERE language='zh_hans'`); err != nil {
			t.Fatal(err)
		}
		rec = get(t, router, "/api/catalog/tree?language=zh_hans", cookie)
		if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != "null" {
			t.Fatalf("expired catalog cache %d %s", rec.Code, rec.Body.String())
		}
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM ozon_catalog_tree_cache WHERE language='zh_hans'`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("expired cache remains: count=%d err=%v", count, err)
		}
	})

	t.Run("render_partial_batch_and_idempotent_final", func(t *testing.T) {
		f := f
		f.t = t
		row, _, _, _ := f.rendered(3)
		upload := f.plan(row.ID, "upload", "main-upload")
		if upload.Payload.ManifestDigest != row.RenderEvidence.Digest || upload.Kind != "media.upload" {
			t.Fatalf("upload lost render pin: %+v", upload)
		}
		keys := []string{f.lease(row, 0, "verified"), f.lease(row, 1, "verified"), f.lease(row, 2, "verified")}
		partial := listingMediaData[listingMediaReceipt](t, f.confirm(row.ID, upload.ID, 0, keys[0], "test"))
		if !partial.Applied || partial.Completed != 1 || partial.Total != 3 || partial.MediaState != "uploading" || partial.Row != nil || partial.ViewRevision <= row.ViewRevision {
			t.Fatalf("partial promoted or lost progress: %+v", partial)
		}
		f.jobState(upload.ID, "queued")
		body := map[string]any{"job_id": upload.ID, "images": []any{map[string]any{"index": 1, "object_key": keys[1], "account_id": "test"}, map[string]any{"index": 2, "object_key": keys[2], "account_id": "test"}}}
		batch := listingMediaData[struct {
			Items []listingMediaReceipt `json:"items"`
			Total int                   `json:"total"`
		}](t, f.post("/api/listing/rows/"+row.ID+"/media/images", cookie, body))
		if batch.Total != 2 || len(batch.Items) != 2 || batch.Items[0].Index != 1 || batch.Items[1].Index != 2 || batch.Items[0].Row != nil || batch.Items[1].Row == nil {
			t.Fatalf("invalid ordered batch receipts: %+v", batch)
		}
		last := batch.Items[1]
		if last.MediaState != "ready" || last.Completed != 3 || last.Row.Revision != row.Revision+1 || last.PublicURL != "https://media.example.invalid/"+keys[2] {
			t.Fatalf("final receipt did not settle row: %+v", last)
		}
		f.jobState(upload.ID, "succeeded")
		replay := listingMediaData[listingMediaReceipt](t, f.confirm(row.ID, upload.ID, 2, keys[2], "test"))
		if replay.Row == nil || replay.Row.Revision != last.Row.Revision || replay.ViewRevision != last.ViewRevision {
			t.Fatalf("replay changed durable result: %+v", replay)
		}
		readback := listingMediaData[listingMediaRow](t, get(t, router, "/api/listing/rows/"+row.ID, cookie))
		if readback.MediaState != "ready" || readback.Revision != last.Row.Revision || !bytes.Contains(readback.Media, []byte(keys[0])) {
			t.Fatalf("normal role readback lost media %+v", readback)
		}
	})

	t.Run("command_replay_and_cross_row_conflict", func(t *testing.T) {
		f := f
		f.t = t
		row, _ := f.newRow()
		first := f.plan(row.ID, "slice", "repeat-command")
		if second := f.plan(row.ID, "slice", "repeat-command"); second.ID != first.ID {
			t.Fatal("command minted another job")
		}
		otherRow, _ := f.newRow()
		f.refusal(f.post("/api/listing/rows/"+otherRow.ID+"/prepare", cookie, map[string]any{"operation": "slice", "renderer_contract_version": "browser-wasm-v2", "command_id": "repeat-command"}), 409, "conflict")
	})

	t.Run("cross_tenant_all_media_routes", func(t *testing.T) {
		f := f
		f.t = t
		row, _, render, body := f.rendered(1)
		for _, item := range []struct {
			suffix string
			body   any
		}{
			{"prepare", map[string]any{"operation": "slice", "renderer_contract_version": "browser-wasm-v2"}},
			{"prepare/cancel", nil}, {"media", body},
			{"media/images/0", map[string]any{"job_id": render.ID, "object_key": "wrong", "account_id": "test"}},
			{"media/images", map[string]any{"job_id": render.ID, "images": []any{map[string]any{"index": 0, "object_key": "wrong", "account_id": "test"}}}},
		} {
			t.Run(item.suffix, func(t *testing.T) {
				f.t = t
				f.refusal(f.post("/api/listing/rows/"+row.ID+"/"+item.suffix, other, item.body), 404, "not_found")
			})
		}
	})

	t.Run("cancel_rejects_render_and_upload_callbacks", func(t *testing.T) {
		for _, stage := range []string{"render", "upload"} {
			t.Run(stage, func(t *testing.T) {
				f := f
				f.t = t
				row, _ := f.newRow()
				job := f.plan(row.ID, "slice", uuid.NewString())
				body := listingRenderBody(row, job, 1)
				key := ""
				if stage == "upload" {
					saved := listingMediaData[struct {
						Row listingMediaRow `json:"row"`
					}](t, f.post("/api/listing/rows/"+row.ID+"/media", cookie, body))
					row = saved.Row
					job = f.plan(row.ID, "upload", uuid.NewString())
					key = f.lease(row, 0, "verified")
				}
				cancelled := listingMediaData[listingMediaPlan](t, f.post("/api/listing/rows/"+row.ID+"/prepare/cancel", cookie, nil))
				if len(cancelled.Jobs) != 1 || cancelled.Jobs[0].ID != job.ID {
					t.Fatalf("cancel %+v", cancelled)
				}
				f.jobState(job.ID, "cancelled")
				if stage == "render" {
					f.refusal(f.post("/api/listing/rows/"+row.ID+"/media", cookie, body), 409, "conflict")
				} else {
					f.refusal(f.confirm(row.ID, job.ID, 0, key, "test"), 409, "conflict")
				}
			})
		}
	})

	t.Run("cancel_changed_input_restores_pending", func(t *testing.T) {
		for _, changed := range []string{"source", "template"} {
			t.Run(changed, func(t *testing.T) {
				f := f
				f.t = t
				row, card, _, _ := f.rendered(1)
				query, id := `UPDATE listing_rows SET payload=jsonb_set(payload,'{source,sha256}',to_jsonb($2::text)) WHERE id=$1::uuid`, row.ID
				if changed == "template" {
					query, id = `UPDATE listing_cards SET payload=jsonb_set(payload,'{psdTemplateSha256}',to_jsonb($2::text)) WHERE id=$1::uuid`, card
				}
				if _, err := pool.Exec(ctx, query, id, strings.Repeat("b", 64)); err != nil {
					t.Fatal(err)
				}
				job := f.plan(row.ID, "slice", uuid.NewString())
				cancelled := listingMediaData[listingMediaPlan](t, f.post("/api/listing/rows/"+row.ID+"/prepare/cancel", cookie, nil))
				if len(cancelled.Jobs) != 1 || cancelled.Jobs[0].ID != job.ID {
					t.Fatalf("cancel %+v", cancelled)
				}
				var state string
				if err := pool.QueryRow(ctx, `SELECT media_state FROM listing_rows WHERE id=$1::uuid`, row.ID).Scan(&state); err != nil || state != "pending" {
					t.Fatalf("old rendered evidence survived cancellation: state=%s err=%v", state, err)
				}
				f.plan(row.ID, "slice", uuid.NewString())
			})
		}
	})

	t.Run("changed_source_or_template_rejects_old_render", func(t *testing.T) {
		for _, changed := range []string{"source", "template"} {
			t.Run(changed, func(t *testing.T) {
				f := f
				f.t = t
				row, card := f.newRow()
				job := f.plan(row.ID, "slice", uuid.NewString())
				body := listingRenderBody(row, job, 1)
				query, id := `UPDATE listing_rows SET payload=jsonb_set(payload,'{source,sha256}',to_jsonb($2::text)) WHERE id=$1::uuid`, row.ID
				if changed == "template" {
					query, id = `UPDATE listing_cards SET payload=jsonb_set(payload,'{psdTemplateSha256}',to_jsonb($2::text)) WHERE id=$1::uuid`, card
				}
				if _, err := pool.Exec(ctx, query, id, strings.Repeat("b", 64)); err != nil {
					t.Fatal(err)
				}
				f.refusal(f.post("/api/listing/rows/"+row.ID+"/media", cookie, body), 409, "conflict")
			})
		}
	})

	t.Run("unverified_or_wrong_storage_receipt_is_rejected", func(t *testing.T) {
		for _, invalid := range []string{"unverified", "account", "revision", "dimensions", "expired"} {
			t.Run(invalid, func(t *testing.T) {
				f := f
				f.t = t
				row, _, _, _ := f.rendered(1)
				job := f.plan(row.ID, "upload", uuid.NewString())
				status := "verified"
				account := "test"
				if invalid == "unverified" {
					status = "pending"
				}
				if invalid == "account" {
					account = "other"
				}
				key := f.lease(row, 0, status)
				updates := map[string]string{"revision": "storage_revision=2", "dimensions": "verified_width=9", "expired": "expires_at=clock_timestamp()-interval '1 second'"}
				if change := updates[invalid]; change != "" {
					if _, err := pool.Exec(ctx, `UPDATE media_object_leases SET `+change+` WHERE object_key=$1`, key); err != nil {
						t.Fatal(err)
					}
				}
				f.refusal(f.confirm(row.ID, job.ID, 0, key, account), 409, "media_confirmation_required")
				f.jobState(job.ID, "queued")
			})
		}
	})

	t.Run("render_cas_retries_without_changing_input_pin", func(t *testing.T) {
		f := f
		f.t = t
		row, _ := f.newRow()
		job := f.plan(row.ID, "slice", uuid.NewString())
		body := listingRenderBody(row, job, 1)
		if _, err := pool.Exec(ctx, `UPDATE listing_rows SET revision=revision+1 WHERE id=$1::uuid`, row.ID); err != nil {
			t.Fatal(err)
		}
		stale := listingMediaData[struct {
			Applied bool `json:"applied"`
		}](t, f.post("/api/listing/rows/"+row.ID+"/media", cookie, body))
		if stale.Applied {
			t.Fatal("stale row revision was applied")
		}
		f.jobState(job.ID, "queued")
		body["expected_revision"] = row.Revision + 1
		fresh := listingMediaData[struct {
			Applied bool            `json:"applied"`
			Row     listingMediaRow `json:"row"`
		}](t, f.post("/api/listing/rows/"+row.ID+"/media", cookie, body))
		if !fresh.Applied || fresh.Row.Revision != row.Revision+1 {
			t.Fatalf("fresh CAS %+v", fresh)
		}
		f.jobState(job.ID, "succeeded")
	})
}
