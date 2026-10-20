package integration

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	coremod "github.com/xxww0098/podhub-go/internal/listing/core"
	listing "github.com/xxww0098/podhub-go/internal/listing/core/contract"
	readhttp "github.com/xxww0098/podhub-go/internal/listing/read/http"
	platform "github.com/xxww0098/podhub-go/internal/listing/rules"
)

func TestListingWriteCatalogSSE(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	platform.InvalidateBannedTags()
	engine, err := listing.OpenEmbedded(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close(context.Background()) })

	owner, orgA := insertWorkspace(t, ctx, pool, "cards-a@example.com", "Cards A")
	_, orgB := insertWorkspace(t, ctx, pool, "cards-b@example.com", "Cards B")
	const (
		cardA = "11111111-1111-4111-8111-111111111111"
		cardB = "22222222-2222-4222-8222-222222222222"
		cardC = "33333333-3333-4333-8333-333333333333"
		rowA  = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	)
	insertCard(t, ctx, pool, cardA, orgA, "甲", "2026-08-21 17:30:00+00", `{"descriptionCategoryId":9,"typeId":8,"language":"zh_hans"}`)
	insertCard(t, ctx, pool, cardB, orgA, "乙", "2026-08-21 17:29:00+00", `{}`)
	insertCard(t, ctx, pool, cardC, orgB, "丙", "2026-08-21 17:31:00+00", `{}`)
	insertListingRow(t, ctx, pool, rowA, orgA, cardA)
	insertSchema(t, ctx, pool)

	clock := func() time.Time { return time.UnixMilli(1787333400000).UTC() }
	ownerH := surfaceHandler(pool, engine, access.Principal{UserID: owner, OrgID: orgA, WorkspaceRole: "owner", PlatformRole: "super_admin"}, clock)
	viewerH := surfaceHandler(pool, engine, access.Principal{UserID: owner, OrgID: orgA, WorkspaceRole: "viewer", PlatformRole: "user"}, clock)
	memberH := surfaceHandler(pool, engine, access.Principal{UserID: owner, OrgID: orgA, WorkspaceRole: "member", PlatformRole: "user"}, clock)

	expect(t, memberH, http.MethodGet, "/api/listing/cards?limit=1", http.StatusOK,
		`{"data":{"items":[{"id":"11111111-1111-4111-8111-111111111111","title":"甲","revision":1,"payload":{"descriptionCategoryId":9,"language":"zh_hans","typeId":8},"updatedAtMs":1787333400000}],"nextCursor":"1787333400000000:11111111-1111-4111-8111-111111111111"}}`)
	expect(t, memberH, http.MethodGet, "/api/listing/cards?limit=100", http.StatusOK,
		`{"data":{"items":[{"id":"11111111-1111-4111-8111-111111111111","title":"甲","revision":1,"payload":{"descriptionCategoryId":9,"language":"zh_hans","typeId":8},"updatedAtMs":1787333400000},{"id":"22222222-2222-4222-8222-222222222222","title":"乙","revision":1,"payload":{},"updatedAtMs":1787333340000}]}}`)
	expect(t, memberH, http.MethodGet, "/api/listing/cards/"+cardC, http.StatusNotFound, `{"error":"上架方案不存在","code":"not_found"}`)
	expect(t, viewerH, http.MethodGet, "/api/listing/cards", http.StatusForbidden, `{"error":"当前角色无权执行此操作","code":"forbidden"}`)

	rec := callJSON(ownerH, http.MethodPatch, "/api/listing/cards/"+cardB, `{"baseRevision":1,"title":"改"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"title":"改"`) || !strings.Contains(rec.Body.String(), `"revision":2`) {
		t.Fatalf("title cas %d %s", rec.Code, rec.Body.String())
	}
	stale := callJSON(ownerH, http.MethodPatch, "/api/listing/cards/"+cardB, `{"baseRevision":1,"title":"再"}`)
	if stale.Code != http.StatusConflict || !strings.Contains(stale.Body.String(), "上架方案已被他人更新，请刷新后重试") {
		t.Fatalf("card conflict %d %s", stale.Code, stale.Body.String())
	}
	var revision int64
	if err := pool.QueryRow(ctx, `SELECT revision FROM listing_cards WHERE id = $1::uuid`, cardB).Scan(&revision); err != nil || revision != 2 {
		t.Fatalf("revision %d %v", revision, err)
	}

	expect(t, ownerH, http.MethodDelete, "/api/listing/cards/"+cardB, http.StatusOK,
		`{"data":{"id":"22222222-2222-4222-8222-222222222222","deletedRows":0}}`)

	rowStale := callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+rowA, `{"baseRevision":2,"draft":{"values":{},"complex_values":[]}}`)
	if rowStale.Code != http.StatusConflict || !strings.Contains(rowStale.Body.String(), "商品行已被他人更新，请刷新后重试") {
		t.Fatalf("row conflict %d %s", rowStale.Code, rowStale.Body.String())
	}
	banned := callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+rowA, `{"baseRevision":1,"draft":{"values":{"tags":{"kind":"text","value":"сигареты"}},"complex_values":[]}}`)
	if banned.Code != http.StatusBadRequest || !strings.Contains(banned.Body.String(), `"code":"validation"`) {
		t.Fatalf("banned %d %s", banned.Code, banned.Body.String())
	}
	clean := callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+rowA, `{"baseRevision":1,"draft":{"values":{"tags":{"kind":"text","value":"роза"}},"complex_values":[]}}`)
	if clean.Code != http.StatusBadRequest || !strings.Contains(clean.Body.String(), "商品行载荷不是可校验的上架文档") {
		t.Fatalf("clean %d %s", clean.Code, clean.Body.String())
	}
	if err := pool.QueryRow(ctx, `SELECT revision FROM listing_rows WHERE id = $1::uuid`, rowA).Scan(&revision); err != nil || revision != 1 {
		t.Fatalf("row revision changed %d %v", revision, err)
	}

	created := callJSON(ownerH, http.MethodPost, "/api/admin/banned-tags", `{"term":"alpha","matchMode":"exact","note":" n "}`)
	if created.Code != http.StatusOK || !strings.Contains(created.Body.String(), `"term":"alpha"`) {
		t.Fatalf("create tag %d %s", created.Code, created.Body.String())
	}
	me := httptest.NewRecorder()
	memberH.ServeHTTP(me, httptest.NewRequest(http.MethodGet, "/api/me/catalog/banned-tags", nil))
	if !strings.Contains(me.Body.String(), `"term":"alpha"`) {
		t.Fatalf("cache %s", me.Body.String())
	}
	var audits int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action = 'banned_tag_created'`).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("audit %d %v", audits, err)
	}
	again := callJSON(ownerH, http.MethodPost, "/api/admin/banned-tags", `{"term":"alpha","matchMode":"exact"}`)
	if again.Code != http.StatusConflict {
		t.Fatalf("duplicate %d %s", again.Code, again.Body.String())
	}

	pack := callJSON(ownerH, http.MethodPost, "/api/field-packs", `{"name":"一","coordinate":{"description_category_id":9,"type_id":8,"language":"zh_hans"},"draft":{"values":{"a":{"kind":"text","value":"x"}},"complex_values":[]}}`)
	if pack.Code != http.StatusOK || !strings.Contains(pack.Body.String(), `"active":true`) || !strings.Contains(pack.Body.String(), `"author_is_self":true`) {
		t.Fatalf("pack %d %s", pack.Code, pack.Body.String())
	}
	second := callJSON(ownerH, http.MethodPost, "/api/field-packs", `{"name":"二","coordinate":{"description_category_id":9,"type_id":8,"language":"zh_hans"},"draft":{"values":{},"complex_values":[]}}`)
	if second.Code != http.StatusOK || !strings.Contains(second.Body.String(), `"active":false`) {
		t.Fatalf("second %d %s", second.Code, second.Body.String())
	}

	insertTree(t, ctx, pool, clock().UnixMilli())
	expect(t, memberH, http.MethodGet, "/api/catalog/tree?language=zh_hans", http.StatusOK,
		`{"language":"zh_hans","fetched_at_ms":1787333400000,"items":[{"description_category_id":1,"category_name":"a","type_id":2,"type_name":"b","disabled":false,"parent_id":null}]}`)
	expect(t, memberH, http.MethodGet, "/api/catalog/tree?language=en", http.StatusOK, `null`)
	store := httptest.NewRecorder()
	memberH.ServeHTTP(store, httptest.NewRequest(http.MethodGet, "/api/catalog/tree?language=zh_hans&store_id="+cardA, nil))
	if store.Code != http.StatusNotFound || !strings.Contains(store.Body.String(), `"error":"Store 不存在"`) {
		t.Fatalf("store fill %d %s", store.Code, store.Body.String())
	}

	bare, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer bare.Release()
	tx, err := bare.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	var n int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM listing_cards`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("missing GUC sees %d %v", n, err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO listing_cards (id, org_id, title) VALUES ('55555555-5555-4555-8555-555555555555'::uuid, $1, 'x')`, orgA); err == nil {
		t.Fatal("missing GUC inserted a card")
	}
}

func TestListingCardEventSSE(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	owner, org := insertWorkspace(t, ctx, pool, "sse@example.com", "SSE")
	const card = "44444444-4444-4444-8444-444444444444"
	insertCard(t, ctx, pool, card, org, "流", "2026-08-21 17:30:00+00", `{}`)
	sha := strings.Repeat("cd", 32)
	if _, err := pool.Exec(ctx, `
		UPDATE listing_cards
		SET payload = jsonb_build_object('psdTemplateSha256', $2::text)
		WHERE id = $1::uuid`, card, sha); err != nil {
		t.Fatal(err)
	}
	engine, err := listing.OpenEmbedded(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close(context.Background()) })
	h := surfaceHandler(pool, engine, access.Principal{UserID: owner, OrgID: org, WorkspaceRole: "owner", PlatformRole: "user"}, time.Now)
	reqCtx, reqCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer reqCancel()
	req := httptest.NewRequest(http.MethodGet, "/api/listing/events?cards="+card+":0", nil).WithContext(reqCtx)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("sse %d %s", rec.Code, rec.Body.String())
	}
	want := "id: 1\nevent: card.invalidate\ndata: {\"workspaceId\":\"" + strconv.FormatInt(org, 10) +
		"\",\"cardId\":\"" + card + "\",\"seq\":\"1\",\"reason\":\"template_changed\",\"psdTemplateSha256\":\"" + sha + "\"}\n\n"
	if !strings.Contains(rec.Body.String(), want) {
		t.Fatalf("frame %q", rec.Body.String())
	}
}

func TestListingCardRowRoundTrip(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	mod, err := coremod.OpenEmbedded(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = mod.Close(context.Background()) })
	readhttp.BindCore(mod)
	engine, err := listing.OpenEmbedded(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close(context.Background()) })

	owner, orgA := insertWorkspace(t, ctx, pool, "rows-a@example.com", "Rows A")
	_, orgB := insertWorkspace(t, ctx, pool, "rows-b@example.com", "Rows B")
	clock := func() time.Time { return time.UnixMilli(1787333400000).UTC() }
	ownerH := surfaceHandler(pool, engine, access.Principal{UserID: owner, OrgID: orgA, WorkspaceRole: "owner", PlatformRole: "user"}, clock)
	otherH := surfaceHandler(pool, engine, access.Principal{UserID: owner, OrgID: orgB, WorkspaceRole: "owner", PlatformRole: "user"}, clock)

	ones := strings.Repeat("1", 64)
	payload := `{
		"categoryKey":"listing-http-fixture",
		"descriptionCategoryId":17027906,
		"typeId":91976,
		"defaults":{"values":{"price":{"kind":"text","value":"90"}},"complex_values":[]},
		"aiPromptId":"prompt-http",
		"aiPromptSha256":"sha256:prompt",
		"psdTemplateAssetId":"` + ones + `",
		"psdTemplateSha256":"` + ones + `",
		"psdTemplateFileName":"template.psd",
		"aiFieldPolicy":{"allowed_field_keys":[],"protected_field_keys":[]}
	}`
	created := callJSON(ownerH, http.MethodPost, "/api/listing/cards", `{"title":"方案","createMode":"blank","payload":`+payload+`}`)
	if created.Code != http.StatusOK || !strings.Contains(created.Body.String(), `"revision":1`) || !strings.Contains(created.Body.String(), `"title":"方案"`) {
		t.Fatalf("create card %d %s", created.Code, created.Body.String())
	}
	var card struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &card); err != nil || card.Data.ID == "" {
		t.Fatal(created.Body.String())
	}
	copied := callJSON(ownerH, http.MethodPost, "/api/listing/cards/"+card.Data.ID+"/copy", "")
	if copied.Code != http.StatusOK || !strings.Contains(copied.Body.String(), `"title":"方案"`) || strings.Contains(copied.Body.String(), card.Data.ID) {
		t.Fatalf("copy %d %s", copied.Code, copied.Body.String())
	}
	snap := callJSON(ownerH, http.MethodGet, "/api/listing/cards/"+card.Data.ID+"/snapshot", "")
	if snap.Code != http.StatusOK || !strings.Contains(snap.Body.String(), `"cursor":"0"`) || !strings.Contains(snap.Body.String(), `"unprepared":0`) {
		t.Fatalf("snapshot %d %s", snap.Code, snap.Body.String())
	}
	expect(t, otherH, http.MethodGet, "/api/listing/cards/"+card.Data.ID, http.StatusNotFound, `{"error":"上架方案不存在","code":"not_found"}`)

	fields := []byte(`[{"key":"name","label":"name","group":"Attrs","editor":"text","required":false,"collection":false,"attribute_id":"4180","options":[]}]`)
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(fields); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO ozon_catalog_schema_cache (description_category_id, type_id, language, payload, fetched_at_ms, byte_size)
		VALUES (17027906, 91976, 'default', $1, $2, $3)`, buf.Bytes(), clock().UnixMilli(), buf.Len()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO ozon_category_current (description_category_id, type_id, language, fields, content_digest, fetched_at_ms)
		VALUES (17027906, 91976, 'default', '[]'::jsonb, $1, $2)`, "sha256:"+strings.Repeat("ab", 32), clock().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	input, _ := json.Marshal(map[string]any{
		"description_category_id": int64(17027906), "type_id": int64(91976), "fields": json.RawMessage(fields),
	})
	snapshot, err := mod.Snapshot(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	var rev struct {
		Revision string `json:"schema_revision"`
	}
	if err := json.Unmarshal(snapshot, &rev); err != nil || rev.Revision == "" {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO listing_schema_revisions (schema_revision, snapshot) VALUES ($1, $2::jsonb)`, rev.Revision, string(snapshot)); err != nil {
		t.Fatal(err)
	}
	sha := strings.Repeat("ab", 32)
	rowBody := `{"cardId":"` + card.Data.ID + `","source":{"sha256":"` + sha + `","fileName":"a.psd"},"draft":{"values":{},"complex_values":[]},"createKey":"k1","requestFingerprint":"fp1"}`
	row := callJSON(ownerH, http.MethodPost, "/api/listing/rows", rowBody)
	if row.Code != http.StatusOK || !strings.Contains(row.Body.String(), `"created":true`) || !strings.Contains(row.Body.String(), `"revision":1`) {
		t.Fatalf("create row %d %s", row.Code, row.Body.String())
	}
	var listed struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(row.Body.Bytes(), &listed); err != nil || listed.Data.ID == "" {
		t.Fatal(row.Body.String())
	}
	again := callJSON(ownerH, http.MethodPost, "/api/listing/rows", rowBody)
	if again.Code != http.StatusOK || !strings.Contains(again.Body.String(), `"created":false`) || !strings.Contains(again.Body.String(), listed.Data.ID) {
		t.Fatalf("replay %d %s", again.Code, again.Body.String())
	}
	changed := strings.Replace(rowBody, `"values":{}`, `"values":{"name":{"kind":"text","value":"x"}}`, 1)
	conflict := callJSON(ownerH, http.MethodPost, "/api/listing/rows", changed)
	if conflict.Code != http.StatusConflict || !strings.Contains(conflict.Body.String(), "该创建键已用于不同的创建内容") {
		t.Fatalf("fingerprint %d %s", conflict.Code, conflict.Body.String())
	}
	expect(t, otherH, http.MethodGet, "/api/listing/rows/"+listed.Data.ID, http.StatusNotFound, `{"error":"商品行不存在","code":"not_found"}`)
	page := callJSON(ownerH, http.MethodGet, "/api/listing/rows?cardId="+card.Data.ID, "")
	if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), listed.Data.ID) {
		t.Fatalf("list %d %s", page.Code, page.Body.String())
	}
	patched := callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+listed.Data.ID, `{"baseRevision":1,"mode":"light","draft":{"values":{"name":{"kind":"text","value":"n"}},"complex_values":[]}}`)
	if patched.Code != http.StatusOK || !strings.Contains(patched.Body.String(), `"revision":2`) || !strings.Contains(patched.Body.String(), `"value":"n"`) {
		t.Fatalf("patch row %d %s", patched.Code, patched.Body.String())
	}

	bare, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer bare.Release()
	tx, err := bare.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO listing_rows (id, org_id, card_id) VALUES ('66666666-6666-4666-8666-666666666666'::uuid, $1, $2::uuid)`, orgA, card.Data.ID); err == nil {
		t.Fatal("missing GUC inserted a row")
	}
}

func surfaceHandler(pool *pgxpool.Pool, engine listing.Engine, p access.Principal, now func() time.Time) http.Handler {
	router := chi.NewRouter()
	srv := &httpapi.Server{
		Pool: pool, Engine: engine, Access: access.FixedResolver{Principal: &p}, Now: now,
	}
	httpapi.HandlerFromMux(srv, router)
	httpapi.MountDomains(router, srv)
	return specChecked(router)
}

func callJSON(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	return rec
}

func insertCard(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string, org int64, title, updated, payload string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO listing_cards (id, org_id, title, payload, updated_at)
		VALUES ($1::uuid, $2, $3, $4::jsonb, $5::timestamptz)`, id, org, title, payload, updated)
	if err != nil {
		t.Fatal(err)
	}
}

func insertListingRow(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string, org int64, card string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO listing_rows (id, org_id, card_id, payload)
		VALUES ($1::uuid, $2, $3::uuid, '{"draft":{"values":{},"complex_values":[]}}'::jsonb)`, id, org, card)
	if err != nil {
		t.Fatal(err)
	}
}

func insertSchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO ozon_category_current (description_category_id, type_id, language, fields, content_digest, fetched_at_ms)
		VALUES (9, 8, 'zh_hans', $1::jsonb, $2, 1)`,
		`[{"key":"tags","attribute_id":23171}]`, "sha256:"+strings.Repeat("ab", 32))
	if err != nil {
		t.Fatal(err)
	}
}

func insertTree(t *testing.T, ctx context.Context, pool *pgxpool.Pool, fetched int64) {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(`[{"description_category_id":1,"category_name":"a","type_id":2,"type_name":"b","disabled":false}]`)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO ozon_catalog_tree_cache (language, payload, fetched_at_ms, byte_size)
		VALUES ('zh_hans', $1, $2, $3)`, buf.Bytes(), fetched, buf.Len())
	if err != nil {
		t.Fatal(err)
	}
}
