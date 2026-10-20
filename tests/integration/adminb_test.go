package integration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	admindomain "github.com/xxww0098/podhub-go/internal/admin/domain"
	adminhttp "github.com/xxww0098/podhub-go/internal/admin/http"
	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	"github.com/xxww0098/podhub-go/internal/identity"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	core "github.com/xxww0098/podhub-go/internal/listing/core/contract"
	_ "github.com/xxww0098/podhub-go/internal/listing/core/service/engine"
	platform "github.com/xxww0098/podhub-go/internal/listing/rules"
)

const adminBrief = "Товар: керамическая кружка 330 мл с принтом; это НЕ термокружка и НЕ стакан.\n" +
	"Тема: только принт. Неясно → «Абстрактный принт».\n" +
	"Заголовок: `Кружка керамическая 330 мл с принтом \"<тема>\"`\n" +
	"Не пиши: чашка, стакан, термокружка.\n" +
	"Описание: Керамическая кружка 330 мл с принтом: <видимый принт>. Основные цвета: <цвет1> и <цвет2>.\n" +
	"Не выдумывай: вес, высоту, упаковку.\n"

const adminIntegrationKey = "integration-adminb-key-32chars-min"

func TestAdminBCatalogAndMedia(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "admin", "adminb test")
	platform.InvalidateBannedTags()
	t.Setenv("CLOUD_INTEGRATION_CONFIG_KEY", adminIntegrationKey)

	userID, orgID := insertWorkspace(t, ctx, pool, "adminb@pod.example", "AdminB")
	if _, err := pool.Exec(ctx, `UPDATE organizations SET uuid = $2 WHERE id = $1`, orgID, "11111111-1111-4111-8111-111111111111"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO ozon_listing_schema_snapshots (org_id, category_id, updated_at_ms, created_at, updated_at)
		VALUES ($1, 'cat-admin-1', 1, timestamptz '2026-08-21 17:30:00+00', timestamptz '2026-08-21 17:30:00+00')`, orgID); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"ozon_listing_field_templates", "category_prompts", "category_videos"} {
		var rls, force bool
		if err := pool.QueryRow(ctx, `
			SELECT c.relrowsecurity, c.relforcerowsecurity
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'public' AND c.relname = $1`, table).Scan(&rls, &force); err != nil {
			t.Fatal(err)
		}
		if rls || force {
			t.Fatalf("%s has row security", table)
		}
	}

	eng, err := core.OpenEmbedded(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = eng.Close(context.Background()) })
	now := time.Date(2026, 8, 21, 17, 30, 0, 0, time.UTC)
	h := mountAdminB(pool, access.FixedResolver{Principal: &access.Principal{
		UserID: userID, OrgID: orgID, PlatformRole: "super_admin",
	}}, eng, func() time.Time { return now })

	rec := adminCall(h, http.MethodGet, "/api/admin/listing/packages/official?category_id=cat-admin-1", "", nil)
	if rec.Code != http.StatusOK || rec.Body.String() != `{"data":{}}` {
		t.Fatalf("missing package %d %s", rec.Code, rec.Body.String())
	}
	var readMsg string
	var readOrg int64
	if err := pool.QueryRow(ctx, `SELECT org_id, message FROM audit_logs WHERE action = 'official_package_read'`).Scan(&readOrg, &readMsg); err != nil {
		t.Fatal(err)
	}
	if readOrg != 0 || readMsg != `{"found":false,"summary":"读取官方字段包 cat-admin-1"}` {
		t.Fatalf("read audit %d %s", readOrg, readMsg)
	}

	rec = adminCall(h, http.MethodPost, "/api/admin/listing/packages/official", `{"category_id":"missing","name":"n","defaults_json":"{}","dataset_json":"[]"}`, nil)
	adminWant(t, rec, http.StatusBadRequest, "该类目尚无 Schema 快照")
	rec = adminCall(h, http.MethodPost, "/api/admin/listing/packages/official", `{"category_id":" ","name":"n","defaults_json":"{}","dataset_json":"[]"}`, nil)
	adminWant(t, rec, http.StatusBadRequest, "该类目尚无 Schema 快照")
	rec = adminCall(h, http.MethodPost, "/api/admin/listing/packages/official", `{"category_id":"cat-admin-1","name":"`+strings.Repeat("a", 256)+`","defaults_json":"{}","dataset_json":"[]"}`, nil)
	adminWant(t, rec, http.StatusBadRequest, "名称无效")
	rec = adminCall(h, http.MethodPost, "/api/admin/listing/packages/official", `{"category_id":"cat-admin-1","name":"n","defaults_json":"[]","dataset_json":"[]"}`, nil)
	adminWant(t, rec, http.StatusBadRequest, "defaults_json 必须是 JSON 对象")
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal(rec.Header())
	}

	rec = adminCall(h, http.MethodPost, "/api/admin/listing/packages/official", `{"category_id":"cat-admin-1","name":" Official fixture ","defaults_json":"{\"a\":1}","dataset_json":"[]"}`, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create package %d %s", rec.Code, rec.Body.String())
	}
	var created struct {
		Data struct {
			OK      bool `json:"ok"`
			Package struct {
				ID         int64  `json:"id"`
				CategoryID string `json:"category_id"`
				Name       string `json:"name"`
				Status     string `json:"status"`
				Defaults   string `json:"defaults_json"`
			} `json:"package"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if !created.Data.OK || created.Data.Package.CategoryID != "cat-admin-1" || created.Data.Package.Name != "Official fixture" || created.Data.Package.Status != "published" || created.Data.Package.Defaults != `{"a":1}` {
		t.Fatalf("%s", rec.Body.String())
	}
	var createdMsg string
	var createdOrg int64
	if err := pool.QueryRow(ctx, `SELECT org_id, message FROM audit_logs WHERE action = 'official_package_created'`).Scan(&createdOrg, &createdMsg); err != nil {
		t.Fatal(err)
	}
	if createdOrg != 0 || createdMsg != `{"category_id":"cat-admin-1","summary":"创建官方字段包 Official fixture (cat-admin-1)"}` {
		t.Fatalf("create audit %d %s", createdOrg, createdMsg)
	}
	rec = adminCall(h, http.MethodPost, "/api/admin/listing/packages/official", `{"category_id":"cat-admin-1","name":"again","defaults_json":"{}","dataset_json":"[]"}`, nil)
	adminWant(t, rec, http.StatusConflict, "官方")

	promptBody := adminPromptBody("кружка", "brief.md", adminBrief, []string{"#кружка"})
	rec = adminCall(h, http.MethodPost, "/api/admin/prompts", promptBody, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("prompt %d %s", rec.Code, rec.Body.String())
	}
	var prompt struct {
		Data struct {
			Prompt struct {
				ID string `json:"promptId"`
			} `json:"prompt"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &prompt); err != nil || !strings.HasPrefix(prompt.Data.Prompt.ID, "prompt_") {
		t.Fatalf("%v %s", err, rec.Body.String())
	}
	var promptOrg int64
	var by string
	if err := pool.QueryRow(ctx, `SELECT org_id FROM audit_logs WHERE action = 'category_prompt_created'`).Scan(&promptOrg); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT created_by_account_uuid FROM category_prompts WHERE prompt_id = $1`, prompt.Data.Prompt.ID).Scan(&by); err != nil {
		t.Fatal(err)
	}
	if promptOrg != orgID || by != "adminb@pod.example" {
		t.Fatalf("prompt audit org %d by %s", promptOrg, by)
	}
	rec = adminCall(h, http.MethodPut, "/api/admin/prompts/"+prompt.Data.Prompt.ID, adminPromptBody("кружка 2", "brief.txt", adminBrief, []string{"#кружка"}), nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"name":"кружка 2"`) {
		t.Fatalf("prompt update %d %s", rec.Code, rec.Body.String())
	}
	if _, err := pool.Exec(ctx, `INSERT INTO banned_tags (term, match_mode, note, created_by) VALUES ('кружка', 'exact', '', 'test')`); err != nil {
		t.Fatal(err)
	}
	platform.InvalidateBannedTags()
	rec = adminCall(h, http.MethodPut, "/api/admin/prompts/"+prompt.Data.Prompt.ID, adminPromptBody("кружка 2", "brief.txt", adminBrief, []string{"#кружка"}), nil)
	adminWant(t, rec, http.StatusBadRequest, "标签含受限词")
	rec = adminCall(h, http.MethodDelete, "/api/admin/prompts/"+prompt.Data.Prompt.ID, "", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), prompt.Data.Prompt.ID) {
		t.Fatalf("prompt delete %d %s", rec.Code, rec.Body.String())
	}
	rec = adminCall(h, http.MethodDelete, "/api/admin/prompts/"+prompt.Data.Prompt.ID, "", nil)
	adminWant(t, rec, http.StatusNotFound, "提示词不存在或已删除")

	videoBody := `{"name":"clip","videoUrl":"https://cdn.example/a.mp4","durationMs":1000,"descriptionCategoryId":3,"typeId":4}`
	rec = adminCall(h, http.MethodPost, "/api/admin/videos", `{"name":"clip","videoUrl":"http://cdn.example/a.mp4","durationMs":1000,"descriptionCategoryId":3,"typeId":4}`, nil)
	adminWant(t, rec, http.StatusBadRequest, "HTTPS")
	rec = adminCall(h, http.MethodPost, "/api/admin/videos", `{"name":"clip","videoUrl":"https://cdn.example/a.mp4","durationMs":0,"descriptionCategoryId":3,"typeId":4}`, nil)
	adminWant(t, rec, http.StatusBadRequest, "视频时长")
	rec = adminCall(h, http.MethodPost, "/api/admin/videos", videoBody, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("video %d %s", rec.Code, rec.Body.String())
	}
	var video struct {
		Data struct {
			Video struct {
				ID string `json:"videoId"`
			} `json:"video"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &video); err != nil || !strings.HasPrefix(video.Data.Video.ID, "video_") {
		t.Fatalf("%v %s", err, rec.Body.String())
	}
	rec = adminCall(h, http.MethodPut, "/api/admin/videos/"+video.Data.Video.ID, `{"name":"clip 2","videoUrl":"https://cdn.example/b.mp4","durationMs":2,"descriptionCategoryId":3,"typeId":4}`, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"durationMs":2`) {
		t.Fatalf("video update %d %s", rec.Code, rec.Body.String())
	}

	if _, err := pool.Exec(ctx, `DELETE FROM writer_leases WHERE domain = 'admin' AND revoked_at_ms IS NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO writer_leases (domain, holder, holder_instance, fence_token, granted_at_ms, expires_at_ms, heartbeat_at_ms, grant_reason)
		VALUES ('admin', 'axum', 'other:1', 1,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint + 600000,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        'test')`); err != nil {
		t.Fatal(err)
	}
	rec = adminCall(h, http.MethodPost, "/api/admin/videos", videoBody, nil)
	adminWant(t, rec, http.StatusServiceUnavailable, "视频池写入未启用")
	if rec.Body.String() == "" || !strings.Contains(rec.Body.String(), `"WRITES_DISABLED"`) {
		t.Fatal(rec.Body.String())
	}
	if _, err := pool.Exec(ctx, `UPDATE writer_leases SET revoked_at_ms = 1 WHERE domain = 'admin'`); err != nil {
		t.Fatal(err)
	}
	rec = adminCall(h, http.MethodPost, "/api/admin/videos", videoBody, nil)
	adminWant(t, rec, http.StatusServiceUnavailable, "视频池写入未启用")
	if _, err := pool.Exec(ctx, `DELETE FROM writer_leases WHERE domain = 'admin'`); err != nil {
		t.Fatal(err)
	}
	rec = adminCall(h, http.MethodDelete, "/api/admin/videos/"+video.Data.Video.ID, "", nil)
	adminWant(t, rec, http.StatusServiceUnavailable, "视频池写入未启用")
	seedMatchingLease(t, ctx, pool, "admin", "adminb test")
	rec = adminCall(h, http.MethodDelete, "/api/admin/videos/"+video.Data.Video.ID, "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("video delete %d %s", rec.Code, rec.Body.String())
	}
	rec = adminCall(h, http.MethodDelete, "/api/admin/videos/"+video.Data.Video.ID, "", nil)
	adminWant(t, rec, http.StatusNotFound, "视频不存在或已删除")

	rec = adminCall(h, http.MethodGet, "/api/admin/listing/packages/official?category_id=cat-admin-1", "", cookie(strings.Repeat("a", 43)))
	adminWant(t, rec, http.StatusInternalServerError, "服务暂不可用")

	origin := newAdminOrigin()
	origin.put("podhub-persist", "media/notes/a.txt", []byte("note"), "text/plain", "")
	origin.put("podhub-persist", "media/images/workspaces/11111111-1111-4111-8111-111111111111/a.jpg", []byte("image-jpg"), "image/jpeg", "")
	srv := httptest.NewServer(origin)
	t.Cleanup(srv.Close)

	rec = adminCall(h, http.MethodGet, "/api/admin/media/storage?accountId=persist", "", nil)
	adminWant(t, rec, http.StatusServiceUnavailable, "平台尚未配置媒体存储")
	sealAdminConfig(t, ctx, pool, adminIntegrationKey, srv.URL, "adminb@pod.example")

	rec = adminCall(h, http.MethodGet, "/api/admin/media/storage?accountId=persist", "", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"workspaceName":"AdminB"`) || !strings.Contains(rec.Body.String(), `"objects":2`) {
		t.Fatalf("storage %d %s", rec.Code, rec.Body.String())
	}
	rec = adminCall(h, http.MethodGet, "/api/admin/media/objects?accountId=persist&prefix=", "", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"path":"images"`) || !strings.Contains(rec.Body.String(), `"path":"notes"`) {
		t.Fatalf("list %d %s", rec.Code, rec.Body.String())
	}
	rec = adminCall(h, http.MethodGet, "/api/admin/media/storage?accountId=missing", "", nil)
	adminWant(t, rec, http.StatusBadRequest, "媒体存储账号不存在")
	rec = adminCall(h, http.MethodPost, "/api/admin/media/directories", `{"accountId":"slice","path":"x"}`, nil)
	adminWant(t, rec, http.StatusConflict, "中转桶")
	rec = adminCall(h, http.MethodPost, "/api/admin/media/directories", `{"accountId":"persist","path":"album"}`, nil)
	if rec.Code != http.StatusCreated || !strings.Contains(rec.Body.String(), `"path":"album"`) {
		t.Fatalf("dir %d %s", rec.Code, rec.Body.String())
	}
	rec = adminCall(h, http.MethodPost, "/api/admin/media/objects/move", `{"accountId":"persist","sourcePath":"gone.txt","destinationPath":"album/gone.txt","kind":"file"}`, nil)
	adminWant(t, rec, http.StatusNotFound, "源对象不存在")
	rec = adminCall(h, http.MethodPost, "/api/admin/media/objects/move", `{"accountId":"persist","sourcePath":"notes/a.txt","destinationPath":"album/b.txt","kind":"file"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("move %d %s", rec.Code, rec.Body.String())
	}
	rec = adminCall(h, http.MethodPost, "/api/admin/media/objects/delete", `{"accountId":"persist","path":"album/b.txt","kind":"file"}`, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"deleted":1`) {
		t.Fatalf("delete object %d %s", rec.Code, rec.Body.String())
	}
	rec = adminCall(h, http.MethodPost, "/api/admin/media/purge", `{"accountId":"bare","prefix":""}`, nil)
	adminWant(t, rec, http.StatusBadRequest, "删除必须指定对象前缀")
	rec = adminCall(h, http.MethodPost, "/api/admin/media/purge", `{"accountId":"persist","prefix":"media/images/"}`, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"deleted":1`) {
		t.Fatalf("purge %d %s", rec.Code, rec.Body.String())
	}

	body := []byte("hello-admin")
	digest := sha256.Sum256(body)
	shaHex := hex.EncodeToString(digest[:])
	rec = adminCall(h, http.MethodPost, "/api/admin/media/uploads", fmt.Sprintf(
		`{"accountId":"persist","path":"notes/fresh.txt","contentType":"text/plain","bytes":%d,"sha256":"%s"}`, len(body), shaHex), nil)
	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("presign %d %s %v", rec.Code, rec.Body.String(), rec.Header())
	}
	var grant struct {
		Data struct {
			Upload struct {
				Ticket string `json:"uploadTicket"`
				Upload struct {
					URL string `json:"url"`
				} `json:"upload"`
			} `json:"upload"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &grant); err != nil || grant.Data.Upload.Ticket == "" || grant.Data.Upload.Upload.URL == "" {
		t.Fatalf("%v %s", err, rec.Body.String())
	}
	putReq, err := http.NewRequest(http.MethodPut, grant.Data.Upload.Upload.URL, strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	putReq.Header.Set("Content-Type", "text/plain")
	putResp, err := http.DefaultClient.Do(putReq)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, putResp.Body)
	putResp.Body.Close()
	if putResp.StatusCode < 200 || putResp.StatusCode >= 300 {
		t.Fatal(putResp.StatusCode)
	}
	rec = adminCall(h, http.MethodPost, "/api/admin/media/uploads/confirm", fmt.Sprintf(
		`{"accountId":"persist","path":"notes/fresh.txt","uploadTicket":%s}`, jsonString(t, grant.Data.Upload.Ticket)), nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "notes/fresh.txt") {
		t.Fatalf("confirm %d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "private, no-store" || rec.Header().Get("Vary") != "Cookie, Authorization" {
		t.Fatal(rec.Header())
	}

	sealAdminConfig(t, ctx, pool, adminIntegrationKey, "https://example.com", "adminb@pod.example")
	rec = adminCall(h, http.MethodGet, "/api/admin/media/storage?accountId=persist", "", nil)
	adminWant(t, rec, http.StatusServiceUnavailable, "refusing non-loopback media host")
}

func TestAdminBStandingOrder(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	superID, _ := insertWorkspace(t, ctx, pool, "super-adminb@pod.example", "Super")
	userID, _ := insertWorkspace(t, ctx, pool, "user-adminb@pod.example", "User")
	if _, err := pool.Exec(ctx, `UPDATE account_users SET role = 'super_admin' WHERE id = $1`, superID); err != nil {
		t.Fatal(err)
	}
	h := mountAdminB(pool, identity.New(pool), nil, nil)
	superToken := strings.Repeat("s", 43)
	userToken := strings.Repeat("u", 43)
	insertSession(t, ctx, pool, superID, superToken)
	insertSession(t, ctx, pool, userID, userToken)

	rec := adminCall(h, http.MethodGet, "/api/admin/listing/packages/official?category_id=cat", "", cookie(superToken))
	adminWant(t, rec, http.StatusForbidden, "请先绑定验证器")

	insertTotp(t, ctx, pool, superID, false)
	rec = adminCall(h, http.MethodGet, "/api/admin/listing/packages/official?category_id=cat", "", cookie(superToken))
	adminWant(t, rec, http.StatusForbidden, "请先绑定验证器")

	if _, err := pool.Exec(ctx, `UPDATE account_admin_totp SET confirmed_at = clock_timestamp() WHERE user_id = $1`, superID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE account_sessions SET admin_step_up_until = clock_timestamp() - interval '1 minute' WHERE user_id = $1`, superID); err != nil {
		t.Fatal(err)
	}
	rec = adminCall(h, http.MethodGet, "/api/admin/listing/packages/official?category_id=cat", "", cookie(superToken))
	adminWant(t, rec, http.StatusForbidden, "管理操作需要重新验证")

	insertTotp(t, ctx, pool, userID, true)
	if _, err := pool.Exec(ctx, `UPDATE account_sessions SET admin_step_up_until = clock_timestamp() + interval '15 minute' WHERE user_id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	rec = adminCall(h, http.MethodGet, "/api/admin/listing/packages/official?category_id=cat", "", cookie(userToken))
	adminWant(t, rec, http.StatusForbidden, "需要超级管理员权限")

	if _, err := pool.Exec(ctx, `UPDATE account_sessions SET admin_step_up_until = clock_timestamp() + interval '15 minute' WHERE user_id = $1`, superID); err != nil {
		t.Fatal(err)
	}
	rec = adminCall(h, http.MethodGet, "/api/admin/listing/packages/official?category_id=cat", "", cookie(superToken))
	if rec.Code != http.StatusOK || rec.Body.String() != `{"data":{}}` {
		t.Fatalf("step-up %d %s", rec.Code, rec.Body.String())
	}
}

func mountAdminB(pool *pgxpool.Pool, resolver access.Resolver, eng core.Engine, now func() time.Time) http.Handler {
	r := chi.NewRouter()
	adminhttp.Mount(r, adminhttp.Deps{Ported: httpapi.AdminPorted(&httpapi.Server{
		Pool: pool, Access: resolver, Engine: eng, Now: now,
	})})
	return r
}

func adminCall(h http.Handler, method, path, body string, header http.Header) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	for key, values := range header {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	h.ServeHTTP(rec, req)
	return rec
}

func adminWant(t *testing.T, rec *httptest.ResponseRecorder, status int, part string) {
	t.Helper()
	if rec.Code != status || !strings.Contains(rec.Body.String(), part) {
		t.Fatalf("want %d %q got %d %s", status, part, rec.Code, rec.Body.String())
	}
}

func adminPromptBody(name, file, content string, tags []string) string {
	raw, err := json.Marshal(map[string]any{
		"name": name, "fileName": file, "content": content,
		"descriptionCategoryId": 11, "typeId": 22, "fixedTags": tags,
	})
	if err != nil {
		panic(err)
	}
	return string(raw)
}

func cookie(token string) http.Header {
	return http.Header{"Cookie": []string{"sid=" + token}}
}

func insertSession(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64, token string) {
	t.Helper()
	sum := sha256.Sum256([]byte(token))
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_sessions (token_hash, user_id, expires_at)
		VALUES ($1, $2, clock_timestamp() + interval '1 day')`, hex.EncodeToString(sum[:]), userID); err != nil {
		t.Fatal(err)
	}
}

func insertTotp(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64, confirmed bool) {
	t.Helper()
	var at any
	if confirmed {
		at = time.Now().UTC()
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_admin_totp (user_id, secret_nonce, secret_ciphertext, confirmed_at)
		VALUES ($1, $2, $3, $4)`, userID, []byte("0123456789ab"), []byte("0123456789abcdef0"), at); err != nil {
		t.Fatal(err)
	}
}

func sealAdminConfig(t *testing.T, ctx context.Context, pool *pgxpool.Pool, secret, endpoint, by string) {
	t.Helper()
	provider := "legacy_s3"
	plain, err := json.Marshal(map[string]any{
		"schemaVersion": 1,
		"storageBuckets": []map[string]any{
			{
				"id": "persist", "role": "assets", "provider": provider, "endpoint": endpoint, "region": "auto",
				"bucket": "podhub-persist", "keyPrefix": "media", "publicBaseUrl": endpoint + "/public",
				"forcePathStyle": true, "accessKeyId": "AKIATEST", "secretAccessKey": "secretsecretsecretsecret",
				"active": true,
			},
			{
				"id": "slice", "role": "transit", "provider": provider, "endpoint": endpoint, "region": "auto",
				"bucket": "podhub-slices", "keyPrefix": "media", "publicBaseUrl": endpoint + "/public",
				"forcePathStyle": true, "accessKeyId": "AKIATEST", "secretAccessKey": "secretsecretsecretsecret",
				"active": false,
			},
			{
				"id": "bare", "role": "private", "provider": provider, "endpoint": endpoint, "region": "auto",
				"bucket": "podhub-bare", "keyPrefix": "", "publicBaseUrl": endpoint + "/public",
				"forcePathStyle": true, "accessKeyId": "AKIATEST", "secretAccessKey": "secretsecretsecretsecret",
				"active": false,
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	nonce := []byte("0123456789ab")
	sealed, err := admindomain.SealSnapshot(secret, nonce, plain)
	if err != nil {
		t.Fatal(err)
	}
	tag, err := pool.Exec(ctx, `
		UPDATE platform_integration_config
		SET revision = revision + 1, nonce = $1, ciphertext = $2, updated_at_ms = 2, updated_by_account_uuid = $3
		WHERE singleton`, nonce, sealed, by)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() > 0 {
		return
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO platform_integration_config (singleton, revision, nonce, ciphertext, updated_at_ms, updated_by_account_uuid)
		VALUES (true, 1, $1, $2, 1, $3)`, nonce, sealed, by); err != nil {
		t.Fatal(err)
	}
}

type adminBlob struct {
	body  []byte
	ctype string
	meta  string
}

type adminOrigin struct {
	mu   sync.Mutex
	objs map[string]adminBlob
}

func newAdminOrigin() *adminOrigin {
	return &adminOrigin{objs: map[string]adminBlob{}}
}

func (o *adminOrigin) put(bucket, key string, body []byte, ctype, meta string) {
	o.mu.Lock()
	o.objs[bucket+"\n"+key] = adminBlob{body: body, ctype: ctype, meta: meta}
	o.mu.Unlock()
}

func (o *adminOrigin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	bucket, key, _ := strings.Cut(path, "/")
	key, _ = unescapePath(key)
	if r.URL.Query().Get("list-type") == "2" {
		o.list(w, r, bucket)
		return
	}
	id := bucket + "\n" + key
	switch r.Method {
	case http.MethodHead, http.MethodGet:
		o.mu.Lock()
		blob, ok := o.objs[id]
		o.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", blob.ctype)
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(blob.body)))
		if blob.meta != "" {
			w.Header().Set("x-amz-meta-podhub-upload", blob.meta)
		}
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			_, _ = w.Write(blob.body)
		}
	case http.MethodPut:
		if src := r.Header.Get("x-amz-copy-source"); src != "" {
			src = strings.TrimPrefix(src, "/")
			srcBucket, srcKey, _ := strings.Cut(src, "/")
			srcKey, _ = unescapePath(srcKey)
			o.mu.Lock()
			blob, ok := o.objs[srcBucket+"\n"+srcKey]
			if ok {
				o.objs[id] = blob
			}
			o.mu.Unlock()
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("<CopyObjectResult></CopyObjectResult>"))
			return
		}
		raw, _ := io.ReadAll(r.Body)
		o.put(bucket, key, raw, r.Header.Get("Content-Type"), r.Header.Get("x-amz-meta-podhub-upload"))
		w.WriteHeader(http.StatusOK)
	case http.MethodDelete:
		o.mu.Lock()
		_, ok := o.objs[id]
		delete(o.objs, id)
		o.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func (o *adminOrigin) list(w http.ResponseWriter, r *http.Request, bucket string) {
	prefix := r.URL.Query().Get("prefix")
	delim := r.URL.Query().Get("delimiter")
	o.mu.Lock()
	defer o.mu.Unlock()
	var b strings.Builder
	b.WriteString("<ListBucketResult><IsTruncated>false</IsTruncated>")
	seen := map[string]struct{}{}
	for id, blob := range o.objs {
		gotBucket, key, _ := strings.Cut(id, "\n")
		if gotBucket != bucket || !strings.HasPrefix(key, prefix) {
			continue
		}
		rest := key[len(prefix):]
		if delim != "" {
			if i := strings.Index(rest, delim); i >= 0 {
				common := prefix + rest[:i+len(delim)]
				if _, ok := seen[common]; ok {
					continue
				}
				seen[common] = struct{}{}
				b.WriteString("<CommonPrefixes><Prefix>")
				b.WriteString(common)
				b.WriteString("</Prefix></CommonPrefixes>")
				continue
			}
		}
		fmt.Fprintf(&b, "<Contents><Key>%s</Key><Size>%d</Size><LastModified>2026-08-21T17:30:00Z</LastModified></Contents>", key, len(blob.body))
	}
	b.WriteString("</ListBucketResult>")
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(b.String()))
}

func unescapePath(raw string) (string, error) {
	parts := strings.Split(raw, "/")
	for i, part := range parts {
		decoded, err := urlPathUnescape(part)
		if err != nil {
			return "", err
		}
		parts[i] = decoded
	}
	return strings.Join(parts, "/"), nil
}

func urlPathUnescape(s string) (string, error) {
	return strings.NewReplacer("%2F", "/", "%2f", "/").Replace(s), nil
}
