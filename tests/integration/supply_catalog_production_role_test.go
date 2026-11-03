package integration

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestSupplyCatalogProductionRoleHTTP(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	var rawCount int
	var permission *pgconn.PgError
	if err := f.runtime.QueryRow(f.ctx, `SELECT count(*) FROM sc_products`).Scan(&rawCount); !errors.As(err, &permission) || permission.Code != "42501" {
		t.Fatalf("bare login unexpectedly read the catalog: count=%d err=%v", rawCount, err)
	}
	server := httptest.NewServer(f.handler)
	t.Cleanup(server.Close)
	call := func(method, path, token, body string, want int) []byte {
		t.Helper()
		r, err := http.NewRequestWithContext(f.ctx, method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := server.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != want {
			t.Fatalf("%s %s: status=%d want=%d body=%s err=%v", method, path, response.StatusCode, want, raw, err)
		}
		return raw
	}
	var login struct {
		Data struct{ Token string } `json:"data"`
	}
	if err := json.Unmarshal(call(http.MethodPost, "/api/auth/login", "", `{"email":"a96311@example.invalid","password":"original-password"}`, http.StatusOK), &login); err != nil || login.Data.Token == "" {
		t.Fatalf("real login failed: %v", err)
	}
	token := login.Data.Token
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO sc_sources (source_id,name,listed,created_at_ms,updated_at_ms)
		VALUES ('src_read_listed','listed',true,1,1),('src_read_hidden','hidden',false,1,1)`); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		id, source string
		published  bool
	}{
		{"visible", "src_read_listed", true}, {"draft", "src_read_listed", false},
		{"hidden-source", "src_read_hidden", true}, {"unassigned", "src_unassigned", true},
	} {
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO sc_products
			(product_id,source_id,title,description,published,internal_note,gallery,created_at_ms,updated_at_ms,created_by_account_uuid)
			VALUES ($1,$2,$1,'public description',$3,'INTERNAL_ONLY','[{"url":"https://example.invalid/product.jpg"}]',1,1,'fixture')`, item.id, item.source, item.published); err != nil {
			t.Fatal(err)
		}
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO sc_skus
			(sku_id,product_id,platform_code,title,published,created_at_ms,updated_at_ms,created_by_account_uuid)
			VALUES ($1,$2,$1,$1,true,1,1,'fixture')`, "sku-"+item.id, item.id); err != nil {
			t.Fatal(err)
		}
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO sc_price_versions (sku_id,price_cents,created_at_ms,created_by_account_uuid) VALUES ($1,1000,1,'fixture'),($1,1100,2,'fixture')`, "sku-"+item.id); err != nil {
			t.Fatal(err)
		}
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO sc_source_offers (source_id,sku_id,cost_cents,shipping_cost_cents,created_at_ms,updated_at_ms) VALUES ($1,$2,54321,9876,1,1)`, item.source, "sku-"+item.id); err != nil {
			t.Fatal(err)
		}
	}
	list := func(path, auth string, want []string, priced bool) {
		t.Helper()
		raw := call(http.MethodGet, path, auth, "", http.StatusOK)
		for _, private := range []string{"INTERNAL_ONLY", "costCents", "shippingCostCents", "sourceId", "draft", "hidden-source"} {
			if strings.Contains(string(raw), private) {
				t.Fatalf("catalog leaked %q: %s", private, raw)
			}
		}
		if strings.Contains(string(raw), "platformPriceCents") != priced {
			t.Fatalf("unexpected price projection: %s", raw)
		}
		var reply struct {
			Data struct {
				Products []struct {
					ID    string   `json:"productId"`
					Media []string `json:"media"`
					SKUs  []struct {
						Price int64 `json:"platformPriceCents"`
					} `json:"skus"`
				} `json:"products"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &reply); err != nil {
			t.Fatal(err)
		}
		got := make([]string, 0, len(reply.Data.Products))
		for _, p := range reply.Data.Products {
			got = append(got, p.ID)
			if len(p.SKUs) != 1 || (priced && p.SKUs[0].Price != 1100) {
				t.Fatalf("missing or stale SKU: %s", raw)
			}
		}
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("catalog order/visibility got=%v want=%v", got, want)
		}
	}
	t.Run("public seller and detail projections", func(t *testing.T) {
		list("/api/public/platform-catalog", "", []string{"unassigned", "visible"}, false)
		list("/api/platform-catalog", token, []string{"unassigned", "visible"}, true)
		for _, id := range []string{"draft", "hidden-source", "missing"} {
			call(http.MethodGet, "/api/platform-catalog/products/"+id, token, "", http.StatusNotFound)
		}
		detail := call(http.MethodGet, "/api/platform-catalog/products/visible", token, "", http.StatusOK)
		if !strings.Contains(string(detail), `"productId":"visible"`) || !strings.Contains(string(detail), `"platformPriceCents":1100`) || strings.Contains(string(detail), "costCents") || strings.Contains(string(detail), "INTERNAL_ONLY") {
			t.Fatalf("invalid product projection: %s", detail)
		}
		call(http.MethodGet, "/api/platform-catalog", "", "", http.StatusUnauthorized)
		call(http.MethodGet, "/api/platform-catalog/products/visible", "", "", http.StatusUnauthorized)
		f.assertClean(t)
	})
	t.Run("full catalog remains ordered past fifty rows", func(t *testing.T) {
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO sc_products (product_id,source_id,title,published,created_at_ms,updated_at_ms,created_by_account_uuid)
			SELECT 'bulk-'||n,'src_read_listed','bulk-'||n,true,1,1,'fixture' FROM generate_series(1,55) n;
			INSERT INTO sc_skus (sku_id,product_id,platform_code,title,published,created_at_ms,updated_at_ms,created_by_account_uuid)
			SELECT 'sku-bulk-'||n,'bulk-'||n,'bulk-code-'||n,'bulk-'||n,true,1,1,'fixture' FROM generate_series(1,55) n;
			INSERT INTO sc_price_versions (sku_id,price_cents,created_at_ms,created_by_account_uuid)
			SELECT 'sku-bulk-'||n,1100,1,'fixture' FROM generate_series(1,55) n`); err != nil {
			t.Fatal(err)
		}
		want := []string{"unassigned", "visible"}
		for i := 1; i <= 55; i++ {
			want = append(want, fmt.Sprintf("bulk-%d", i))
		}
		sort.Strings(want)
		list("/api/public/platform-catalog", "", want, false)
		list("/api/platform-catalog", token, want, true)
	})
	t.Run("published archival requires a super admin and disappears from all three reads", func(t *testing.T) {
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO sc_catalog_managers (source_id,user_id,status,created_at_ms) VALUES ('src_read_listed',96311,'active',1)`); err != nil {
			t.Fatal(err)
		}
		const archive = `{"title":"visible","platformCode":"sku-visible","costCents":54321,"revision":1,"archived":true}`
		call(http.MethodPut, "/api/supplier-catalog/sources/src_read_listed/rows/visible", token, archive, http.StatusForbidden)
		var archived, productPublished, skuPublished bool
		if err := f.fixture.QueryRow(f.ctx, `SELECT p.archived,p.published,s.published FROM sc_products p JOIN sc_skus s USING(product_id) WHERE p.product_id='visible'`).Scan(&archived, &productPublished, &skuPublished); err != nil || archived || !productPublished || !skuPublished {
			t.Fatalf("manager archival changed state=%v/%v/%v err=%v", archived, productPublished, skuPublished, err)
		}
		if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET role='super_admin' WHERE id=96311`); err != nil {
			t.Fatal(err)
		}
		call(http.MethodPut, "/api/supplier-catalog/sources/src_read_listed/rows/visible", token, archive, http.StatusOK)
		if err := f.fixture.QueryRow(f.ctx, `SELECT p.archived,p.published,s.published FROM sc_products p JOIN sc_skus s USING(product_id) WHERE p.product_id='visible'`).Scan(&archived, &productPublished, &skuPublished); err != nil || !archived || productPublished || skuPublished {
			t.Fatalf("archive state=%v/%v/%v err=%v", archived, productPublished, skuPublished, err)
		}
		for _, path := range []string{"/api/public/platform-catalog", "/api/platform-catalog"} {
			if raw := call(http.MethodGet, path, token, "", http.StatusOK); strings.Contains(string(raw), `"productId":"visible"`) {
				t.Fatalf("archived row remained in %s: %s", path, raw)
			}
		}
		call(http.MethodGet, "/api/platform-catalog/products/visible", token, "", http.StatusNotFound)
		f.assertClean(t)
	})
	t.Run("disabled account cannot reuse its session", func(t *testing.T) {
		if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=96311`); err != nil {
			t.Fatal(err)
		}
		call(http.MethodGet, "/api/platform-catalog", token, "", http.StatusUnauthorized)
		call(http.MethodGet, "/api/platform-catalog/products/unassigned", token, "", http.StatusUnauthorized)
		call(http.MethodGet, "/api/public/platform-catalog", "", "", http.StatusOK)
		f.assertClean(t)
	})
}
