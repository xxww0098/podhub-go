package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	catalogrepo "github.com/xxww0098/podhub-go/internal/admin/catalog/repo"
	configdoc "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	admindomain "github.com/xxww0098/podhub-go/internal/admin/domain"
	adminhttp "github.com/xxww0098/podhub-go/internal/admin/http"
	"github.com/xxww0098/podhub-go/internal/app"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

func TestAdminCatalogRuntimeRole(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	// Login passwords are cluster-wide: always use a private PostgreSQL.
	t.Setenv("PODHUB_PARITY_DSN", "")
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	dsn := securityDSN(t, ctx)
	fixture, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(fixture.Close)
	if err := db.Migrate(ctx, fixture); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'catalog-runtime-test'`); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	login, err := db.Connect(ctx, config.Config{DatabaseURL: swapUser(dsn, "podhub_login_api", "catalog-runtime-test")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(login.Close)
	assertCatalogLogin(t, ctx, login)
	t.Run("media bases", func(t *testing.T) {
		bases, err := (catalogrepo.CatalogRepo{Pool: login}).Bases(ctx)
		if err != nil || len(bases) != 0 {
			t.Fatalf("missing media config: bases=%v err=%v", bases, err)
		}
		bases, err = (catalogrepo.CatalogRepo{Pool: login, PublicBases: func(context.Context) ([]string, error) { return []string{"https://cdn.example/native"}, nil }}).Bases(ctx)
		if err != nil || len(bases) != 1 || bases[0] != "https://cdn.example/native" {
			t.Fatalf("configured media bases=%v err=%v", bases, err)
		}
	})
	t.Run("real admin HTTP", func(t *testing.T) {
		setR2StorageAccount(t, fixture, configdoc.StoredStorage{
			Role: "assets", ID: "catalog", Endpoint: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com",
			AccessKeyID: "CATALOGTEST", SecretAccessKey: "catalog-fixture-secret",
		})
		h := catalogAuthorityHandler(t, ctx, fixture, login)
		product := catalogAuthorityPost(ctx, h, "/api/admin/platform-catalog/products", `{"title":"Runtime catalog","media":["https://podhub-go-supplier.ozon-pod.com/a.jpg"]}`)
		if product.Code != http.StatusCreated {
			t.Fatalf("create product: %d %s", product.Code, product.Body.String())
		}
		var result admindomain.ProductMutation
		if err := json.Unmarshal(product.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		sku := catalogAuthorityPost(ctx, h, "/api/admin/platform-catalog/skus", fmt.Sprintf(`{"productId":%q,"platformCode":"runtime-catalog","title":"Runtime SKU","media":["https://podhub-go-supplier.ozon-pod.com/a.jpg"]}`, result.Data.Product.ProductID))
		if sku.Code != http.StatusCreated {
			t.Fatalf("create SKU: %d %s", sku.Code, sku.Body.String())
		}
		request := httptest.NewRequest(http.MethodGet, "/api/admin/platform-catalog", nil).WithContext(ctx)
		request.Header.Set("Authorization", "Bearer catalog-authority-admin")
		listed := httptest.NewRecorder()
		h.ServeHTTP(listed, request)
		if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), `"platformCode":"runtime-catalog"`) {
			t.Fatalf("list catalog: %d %s", listed.Code, listed.Body.String())
		}
		var products, skus, audits int
		if err := fixture.QueryRow(ctx, `SELECT (SELECT count(*) FROM sc_products), (SELECT count(*) FROM sc_skus), (SELECT count(*) FROM audit_logs WHERE action IN ('sc_product_created','sc_sku_created'))`).Scan(&products, &skus, &audits); err != nil || products != 1 || skus != 1 || audits != 2 {
			t.Fatalf("persisted products=%d skus=%d audits=%d err=%v", products, skus, audits, err)
		}
	})
	assertCatalogLogin(t, ctx, login)
}

func TestAdminCatalogRejectsMediaOutsideConfiguredBase(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "admin", "catalog URL validation")
	h := mountCatalog(pool, &adminhttp.Session{
		UserID: 7, OrgID: 1, PlatformRole: "super_admin", PublicID: "catalog@pod.example",
	}, []string{"https://media.example.invalid", "https://cdn.example/native"})
	var productID string
	for _, target := range []string{"https://media.example.invalid/a.jpg", "https://cdn.example/native/a%20b.jpg?version=1", "https://cdn.example/native/%E5%9B%BE.jpg"} {
		response := catalogAuthorityPost(ctx, h, "/api/admin/platform-catalog/products", fmt.Sprintf(`{"title":"valid","media":[%q]}`, target))
		if response.Code != http.StatusCreated {
			t.Fatalf("valid media %s: %d %s", target, response.Code, response.Body.String())
		}
		var result admindomain.ProductMutation
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		productID = result.Data.Product.ProductID
		var persisted string
		if err := pool.QueryRow(ctx, `SELECT media->>0 FROM sc_products WHERE product_id=$1`, productID).Scan(&persisted); err != nil || persisted != target {
			t.Fatalf("valid media changed: got=%q want=%q err=%v", persisted, target, err)
		}
	}
	for i, target := range []string{
		"https://media.example.invalid.evil/a.jpg",
		"https://media.example.invalid@evil.example/a.jpg",
		"https://media.example.invalid:444/a.jpg",
		"https://cdn.example/native-other/a.jpg",
		"https://cdn.example/native/../private/a.jpg",
		"https://cdn.example/native/%2e%2e/private/a.jpg",
		"https://cdn.example/native%2f..%2fprivate/a.jpg",
	} {
		t.Run(target, func(t *testing.T) {
			for _, kind := range []string{"products", "skus"} {
				body := map[string]any{"title": "rejected", "media": []string{target}}
				if kind == "skus" {
					body["productId"] = productID
					body["platformCode"] = fmt.Sprintf("rejected-%d", i)
				}
				raw, err := json.Marshal(body)
				if err != nil {
					t.Fatal(err)
				}
				response := catalogAuthorityPost(ctx, h, "/api/admin/platform-catalog/"+kind, string(raw))
				if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "图片须先通过图片上传接口") {
					t.Errorf("%s media escaped allowed base: %d %s", kind, response.Code, response.Body.String())
				}
			}
		})
	}
	var products, skus, audits int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM sc_products), (SELECT count(*) FROM sc_skus), (SELECT count(*) FROM audit_logs WHERE action IN ('sc_product_created','sc_sku_created'))`).Scan(&products, &skus, &audits); err != nil || products != 3 || skus != 0 || audits != 3 {
		t.Fatalf("rejected media persisted: products=%d skus=%d audits=%d err=%v", products, skus, audits, err)
	}
}

func catalogAuthorityHandler(t *testing.T, ctx context.Context, fixture, runtime *pgxpool.Pool) http.Handler {
	t.Helper()
	_, admin := seedAITenant(t, ctx, fixture, 96301)
	if _, err := fixture.Exec(ctx, `UPDATE account_users SET role='super_admin' WHERE id=$1`, admin); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.Exec(ctx, `INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 day')`, admindomain.SessionHash("catalog-authority-admin"), admin); err != nil {
		t.Fatal(err)
	}
	seedMatchingLease(t, ctx, fixture, "admin", "catalog authority test")
	return app.Handler(runtime)
}

func catalogAuthorityPost(ctx context.Context, h http.Handler, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)).WithContext(ctx)
	request.Header.Set("Authorization", "Bearer catalog-authority-admin")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	return response
}

func assertCatalogLogin(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	var current, session string
	var super, bypass, inherit bool
	if err := pool.QueryRow(ctx, `SELECT current_user,session_user,rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user`).Scan(&current, &session, &super, &bypass, &inherit); err != nil || current != "podhub_login_api" || session != current || super || bypass || inherit {
		t.Fatalf("login current=%s session=%s super=%v bypass=%v inherit=%v err=%v", current, session, super, bypass, inherit, err)
	}
}
