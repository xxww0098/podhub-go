package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	catalogrepo "github.com/xxww0098/podhub-go/internal/admin/catalog/repo"
	admindomain "github.com/xxww0098/podhub-go/internal/admin/domain"
	adminhttp "github.com/xxww0098/podhub-go/internal/admin/http"
	adminsvc "github.com/xxww0098/podhub-go/internal/admin/service"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

const catalogKey = "catalog-whitelist-key-32chars-minx"

func TestCatalogMediaURLWhitelist(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "admin", "catalog test")
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM writer_leases WHERE holder_instance = 'x4a-catalog'`)
	})
	sess := &adminhttp.Session{
		UserID: 7, OrgID: 1, PlatformRole: "super_admin", PublicID: "catalog@pod.example",
		TotpEnrolled: true, StepUpElevated: true,
	}
	ready := mountCatalog(pool, sess, catalogKey)
	shortH := mountCatalog(pool, sess, "short")
	exampleH := mountCatalog(pool, sess, seal.ExampleIntegrationKey)

	var rls bool
	if err := pool.QueryRow(ctx, `
		SELECT c.relrowsecurity
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relname = 'sc_products'`).Scan(&rls); err != nil || rls {
		t.Fatalf("sc_products rls %v %v", rls, err)
	}

	csrf := adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"csrf"}`, http.Header{
		"Cookie": []string{"sid=abc"}, "Sec-Fetch-Site": []string{"cross-site"},
	})
	wantBody(t, csrf, http.StatusForbidden, `{"code":"csrf_rejected","message":"跨站请求已被拒绝"}`)
	if csrf.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal(csrf.Header())
	}
	got := adminCall(ready, http.MethodGet, "/api/admin/platform-catalog", "", http.Header{
		"Cookie": []string{"sid=abc"}, "Sec-Fetch-Site": []string{"cross-site"},
	})
	if got.Code != http.StatusOK || strings.Contains(got.Body.String(), "csrf_rejected") || got.Body.String() != `{"data":{"products":[],"skus":[]}}` {
		t.Fatalf("get %d %s", got.Code, got.Body.String())
	}

	sess.UserID = 0
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"x"}`, nil), http.StatusUnauthorized, `{"error":"未登录","code":"AUTH_INVALID"}`)
	sess.UserID = 7
	sess.PlatformRole = "admin"
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"x"}`, nil), http.StatusForbidden, `{"error":"需要超级管理员权限","code":"FORBIDDEN"}`)
	sess.PlatformRole = "super_admin"
	sess.TotpEnrolled = false
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"x"}`, nil), http.StatusForbidden, `{"error":"请先绑定验证器","code":"FORBIDDEN"}`)
	sess.TotpEnrolled = true
	sess.StepUpElevated = false
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"x"}`, nil), http.StatusForbidden, `{"error":"管理操作需要重新验证","code":"FORBIDDEN"}`)
	sess.StepUpElevated = true

	empty := adminCall(shortH, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"empty-ok"}`, nil)
	if empty.Code != http.StatusCreated || empty.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("empty %d %s", empty.Code, empty.Body.String())
	}
	rejected := adminCall(shortH, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"rejected","media":["https://media.example.invalid/a.jpg"]}`, nil)
	wantBody(t, rejected, http.StatusBadRequest, `{"error":"图片须先通过图片上传接口写入媒体存储","code":"VALIDATION"}`)
	var n int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sc_products WHERE title = 'rejected'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("rejected stored %d %v", n, err)
	}

	sealCatalogBases(t, ctx, pool, catalogKey, []map[string]any{
		{"id": "media", "publicBaseUrl": "https://media.example.invalid", "active": false},
		{"id": "native", "publicBaseUrl": "https://cdn.example/native", "active": true},
		{"id": "blank", "publicBaseUrl": ""},
		{"id": "space", "publicBaseUrl": " "},
	})
	evil := adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"evil","media":["  https://media.example.invalid.evil/a.jpg  "]}`, nil)
	if evil.Code != http.StatusCreated || !strings.Contains(evil.Body.String(), `"https://media.example.invalid.evil/a.jpg"`) || strings.Contains(evil.Body.String(), "  https://") {
		t.Fatalf("evil %d %s", evil.Code, evil.Body.String())
	}
	var wrapped struct {
		Data struct {
			Product struct {
				ID string `json:"productId"`
			} `json:"product"`
		} `json:"data"`
	}
	if json.Unmarshal(evil.Body.Bytes(), &wrapped) != nil || wrapped.Data.Product.ID == "" {
		t.Fatal(evil.Body.String())
	}
	productID := wrapped.Data.Product.ID
	var media string
	if err := pool.QueryRow(ctx, `SELECT media::text FROM sc_products WHERE product_id = $1`, productID).Scan(&media); err != nil || media != `["https://media.example.invalid.evil/a.jpg"]` {
		t.Fatalf("stored %s %v", media, err)
	}
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"upper","media":["HTTPS://media.example.invalid/a.jpg"]}`, nil), http.StatusBadRequest, `{"error":"图片须先通过图片上传接口写入媒体存储","code":"VALIDATION"}`)
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"other","media":["https://other.example/a.jpg"]}`, nil), http.StatusBadRequest, `{"error":"图片须先通过图片上传接口写入媒体存储","code":"VALIDATION"}`)
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"supplier","media":["https://supplier.example.invalid/a.jpg"]}`, nil), http.StatusBadRequest, `{"error":"图片须先通过图片上传接口写入媒体存储","code":"VALIDATION"}`)
	inactive := adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"inactive","media":["https://media.example.invalid/a.jpg"]}`, nil)
	if inactive.Code != http.StatusCreated {
		t.Fatalf("inactive %d %s", inactive.Code, inactive.Body.String())
	}
	native := adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"native","media":["https://cdn.example/native/a.jpg"]}`, nil)
	if native.Code != http.StatusCreated {
		t.Fatalf("native %d %s", native.Code, native.Body.String())
	}

	sealCatalogBases(t, ctx, pool, catalogKey, []map[string]any{
		{"id": "slash", "publicBaseUrl": "https://cdn.example/native/", "active": true},
	})
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"slash","media":["https://cdn.example/native"]}`, nil), http.StatusBadRequest, `{"error":"图片须先通过图片上传接口写入媒体存储","code":"VALIDATION"}`)

	sealCatalogBases(t, ctx, pool, catalogKey, []map[string]any{
		{"id": "media", "publicBaseUrl": "https://media.example.invalid", "active": true},
	})
	var many strings.Builder
	many.WriteString(`{"title":"many","media":[`)
	for i := 0; i < 21; i++ {
		if i > 0 {
			many.WriteByte(',')
		}
		many.WriteString(`"x"`)
	}
	many.WriteString(`]}`)
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", many.String(), nil), http.StatusBadRequest, `{"error":"媒体最多 20 项","code":"VALIDATION"}`)
	long := strings.Repeat("a", 2049)
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"long","media":["`+long+`"]}`, nil), http.StatusBadRequest, `{"error":"每条媒体地址需为 1–2048 个字符","code":"VALIDATION"}`)
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"blank","media":["   "]}`, nil), http.StatusBadRequest, `{"error":"每条媒体地址需为 1–2048 个字符","code":"VALIDATION"}`)

	skuRec := adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/skus", `{"productId":"`+productID+`","platformCode":"code-x4","title":"sku"}`, nil)
	if skuRec.Code != http.StatusCreated {
		t.Fatalf("sku %d %s", skuRec.Code, skuRec.Body.String())
	}
	var sku struct {
		Data struct {
			SKU struct {
				ID string `json:"skuId"`
			} `json:"sku"`
		} `json:"data"`
	}
	if json.Unmarshal(skuRec.Body.Bytes(), &sku) != nil || sku.Data.SKU.ID == "" {
		t.Fatal(skuRec.Body.String())
	}
	if _, err := pool.Exec(ctx, `
		UPDATE platform_integration_config
		SET nonce = $1, ciphertext = $2
		WHERE singleton`, []byte("0123456789ab"), []byte("not-a-ciphertext")); err != nil {
		t.Fatal(err)
	}
	garbage := adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"garbage"}`, nil)
	wantBody(t, garbage, http.StatusServiceUnavailable, `{"error":"服务暂不可用","code":"MEDIA_UNAVAILABLE"}`)
	if garbage.Header().Get("Retry-After") != "" {
		t.Fatal(garbage.Header().Get("Retry-After"))
	}
	missingKey := adminCall(shortH, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"nokey"}`, nil)
	wantBody(t, missingKey, http.StatusServiceUnavailable, `{"error":"平台连接配置密钥未设置","code":"MEDIA_UNAVAILABLE"}`)
	example := adminCall(exampleH, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"example"}`, nil)
	wantBody(t, example, http.StatusServiceUnavailable, `{"error":"平台连接配置密钥不能使用 .env.example 中的占位值","code":"MEDIA_UNAVAILABLE"}`)

	sealCatalogBases(t, ctx, pool, catalogKey, []map[string]any{
		{"id": "media", "publicBaseUrl": "https://media.example.invalid", "active": true},
	})
	if _, err := pool.Exec(ctx, `DELETE FROM writer_leases WHERE domain = 'admin' AND revoked_at_ms IS NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO writer_leases (domain, holder, holder_instance, fence_token, granted_at_ms, expires_at_ms, heartbeat_at_ms, grant_reason)
		VALUES ('admin', 'axum', 'x4a-catalog', 1,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint + 600000,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        'test')`); err != nil {
		t.Fatal(err)
	}
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"leased"}`, nil), http.StatusServiceUnavailable, `{"error":"平台目录写入未启用","code":"WRITES_DISABLED"}`)
	if _, err := pool.Exec(ctx, `UPDATE writer_leases SET revoked_at_ms = 1 WHERE holder_instance = 'x4a-catalog'`); err != nil {
		t.Fatal(err)
	}
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"revoked"}`, nil), http.StatusServiceUnavailable, `{"error":"平台目录写入未启用","code":"WRITES_DISABLED"}`)
	if _, err := pool.Exec(ctx, `DELETE FROM writer_leases WHERE holder_instance = 'x4a-catalog'`); err != nil {
		t.Fatal(err)
	}
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"empty"}`, nil), http.StatusServiceUnavailable, `{"error":"平台目录写入未启用","code":"WRITES_DISABLED"}`)
	seedMatchingLease(t, ctx, pool, "admin", "catalog test")
	opened := adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"opened"}`, nil)
	if opened.Code != http.StatusCreated {
		t.Fatalf("opened %d %s", opened.Code, opened.Body.String())
	}
}

func mountCatalog(pool *pgxpool.Pool, sess *adminhttp.Session, key string) http.Handler {
	r := chi.NewRouter()
	adminhttp.Mount(r, adminhttp.Deps{
		Resolve: func(*http.Request) (*adminhttp.Session, *adminhttp.Refusal, error) {
			return sess, nil, nil
		},
		Catalog: adminsvc.NewCatalog(catalogrepo.CatalogRepo{Pool: pool, Key: key}, adminsvc.CatalogOptions{}),
	})
	return r
}

func sealCatalogBases(t *testing.T, ctx context.Context, pool *pgxpool.Pool, secret string, accounts []map[string]any) {
	t.Helper()
	plain, err := json.Marshal(map[string]any{
		"schemaVersion":  1,
		"storageBuckets": accounts,
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
		WHERE singleton`, nonce, sealed, "catalog@pod.example")
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() > 0 {
		return
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO platform_integration_config (singleton, revision, nonce, ciphertext, updated_at_ms, updated_by_account_uuid)
		VALUES (true, 1, $1, $2, 1, $3)`, nonce, sealed, "catalog@pod.example"); err != nil {
		t.Fatal(err)
	}
}
