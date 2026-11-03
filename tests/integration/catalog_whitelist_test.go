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
	adminhttp "github.com/xxww0098/podhub-go/internal/admin/http"
	adminsvc "github.com/xxww0098/podhub-go/internal/admin/service"
)

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
	}
	ready := mountCatalog(pool, sess, nil)
	missingStorage := mountCatalog(pool, sess, nil)

	// 00365 turned RLS on for the catalog tables. Assert the post-00365
	// invariant instead of the old "no RLS" world: forced RLS with at least
	// one policy, so a bare table read cannot see every product.
	var rls, forced bool
	var policies int
	if err := pool.QueryRow(ctx, `
		SELECT c.relrowsecurity, c.relforcerowsecurity,
		       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relname = 'sc_products'`).Scan(&rls, &forced, &policies); err != nil {
		t.Fatalf("sc_products rls probe: %v", err)
	}
	if !rls || !forced || policies == 0 {
		t.Fatalf("sc_products rls=%v forced=%v policies=%d", rls, forced, policies)
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

	empty := adminCall(missingStorage, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"empty-ok"}`, nil)
	if empty.Code != http.StatusCreated || empty.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("empty %d %s", empty.Code, empty.Body.String())
	}
	rejected := adminCall(missingStorage, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"rejected","media":["https://media.example.invalid/a.jpg"]}`, nil)
	wantBody(t, rejected, http.StatusBadRequest, `{"error":"图片须先通过图片上传接口写入媒体存储","code":"VALIDATION"}`)
	var n int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sc_products WHERE title = 'rejected'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("rejected stored %d %v", n, err)
	}

	ready = mountCatalog(pool, sess, []string{"https://media.example.invalid", "https://cdn.example/native"})
	evil := adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"evil","media":["  https://media.example.invalid.evil/a.jpg  "]}`, nil)
	wantBody(t, evil, http.StatusBadRequest, `{"error":"图片须先通过图片上传接口写入媒体存储","code":"VALIDATION"}`)
	valid := adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"valid","media":["  https://media.example.invalid/a.jpg  "]}`, nil)
	if valid.Code != http.StatusCreated || strings.Contains(valid.Body.String(), "  https://") {
		t.Fatalf("valid %d %s", valid.Code, valid.Body.String())
	}
	var wrapped struct {
		Data struct {
			Product struct {
				ID string `json:"productId"`
			} `json:"product"`
		} `json:"data"`
	}
	if json.Unmarshal(valid.Body.Bytes(), &wrapped) != nil || wrapped.Data.Product.ID == "" {
		t.Fatal(valid.Body.String())
	}
	productID := wrapped.Data.Product.ID
	var media string
	if err := pool.QueryRow(ctx, `SELECT media::text FROM sc_products WHERE product_id = $1`, productID).Scan(&media); err != nil || media != `["https://media.example.invalid/a.jpg"]` {
		t.Fatalf("stored %s %v", media, err)
	}
	if upper := adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"upper","media":["HTTPS://media.example.invalid/a.jpg"]}`, nil); upper.Code != http.StatusCreated {
		t.Fatalf("uppercase scheme: %d %s", upper.Code, upper.Body.String())
	}
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"other","media":["https://other.example/a.jpg"]}`, nil), http.StatusBadRequest, `{"error":"图片须先通过图片上传接口写入媒体存储","code":"VALIDATION"}`)
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"supplier","media":["https://supplier.example.invalid/a.jpg"]}`, nil), http.StatusBadRequest, `{"error":"图片须先通过图片上传接口写入媒体存储","code":"VALIDATION"}`)
	native := adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"native","media":["https://cdn.example/native/a.jpg"]}`, nil)
	if native.Code != http.StatusCreated {
		t.Fatalf("native %d %s", native.Code, native.Body.String())
	}

	ready = mountCatalog(pool, sess, []string{"https://cdn.example/native/"})
	wantBody(t, adminCall(ready, http.MethodPost, "/api/admin/platform-catalog/products", `{"title":"slash","media":["https://cdn.example/native"]}`, nil), http.StatusBadRequest, `{"error":"图片须先通过图片上传接口写入媒体存储","code":"VALIDATION"}`)

	ready = mountCatalog(pool, sess, []string{"https://media.example.invalid"})
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

func mountCatalog(pool *pgxpool.Pool, sess *adminhttp.Session, bases []string) http.Handler {
	r := chi.NewRouter()
	adminhttp.Mount(r, adminhttp.Deps{
		Resolve: func(*http.Request) (*adminhttp.Session, *adminhttp.Refusal, error) {
			return sess, nil, nil
		},
		Catalog: adminsvc.NewCatalog(catalogrepo.CatalogRepo{Pool: pool, PublicBases: bases}, adminsvc.CatalogOptions{}),
	})
	return r
}
