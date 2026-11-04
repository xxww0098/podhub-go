package integration

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

func TestCatalogPublicationAndPriceAuthority(t *testing.T) {
	f := newSupplierCatalogHTTPFixture(t)
	seedMatchingLease(t, f.ctx, f.pool, "admin", "publication permission integration")
	base := "/api/supplier-catalog/sources/" + f.sourceA + "/rows"
	row := supplierCatalogRow(t, f.call(t, http.MethodPost, base, f.cookieA, `{"title":"Published","platformCode":"pub-permission","costCents":100}`, http.StatusCreated))
	f.ready(t, row)
	if _, err := f.pool.Exec(f.ctx, `UPDATE sc_sources SET created_by_account_uuid=(SELECT public_id FROM account_users WHERE id=$2) WHERE source_id=$1`, f.sourceA, f.managerA); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE supplier_ozon_configs SET prompt_text=$2 WHERE product_id=$1`, row.ProductID, `{"product_type_ru":"Кружка","facts_ru":"Керамическая кружка, 350 мл."}`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE sc_products SET published=true WHERE product_id=$1;`, row.ProductID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE sc_skus SET published=true WHERE sku_id=$1;`, row.SKUID); err != nil {
		t.Fatal(err)
	}
	path := base + "/" + row.ProductID
	adminPath := "/api/admin/supplier-dbs/" + f.sourceA + "/rows/" + row.ProductID
	for _, role := range []string{"user", "admin"} {
		t.Run(role, func(t *testing.T) {
			if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET role=$2 WHERE id=$1`, f.managerA, role); err != nil {
				t.Fatal(err)
			}
			for _, action := range []string{"publish", "unpublish"} {
				f.call(t, http.MethodPost, path+"/"+action, f.cookieA, "", http.StatusForbidden)
				f.call(t, http.MethodPost, adminPath+"/"+action, f.cookieA, "", http.StatusForbidden)
			}
			f.call(t, http.MethodPost, adminPath+"/price", f.cookieA, `{"priceCents":2000,"note":"denied"}`, http.StatusForbidden)
			f.call(t, http.MethodPut, path, f.cookieA, fmt.Sprintf(`{"title":"Archive","platformCode":"pub-permission","archived":true,"revision":%d}`, row.Revision), http.StatusForbidden)
			f.call(t, http.MethodDelete, path, f.cookieA, "", http.StatusForbidden)
			if role == "admin" {
				f.call(t, http.MethodPut, adminPath, f.cookieA, fmt.Sprintf(`{"title":"Archive","platformCode":"pub-permission","archived":true,"expectedRevision":%d}`, row.Revision), http.StatusForbidden)
				f.call(t, http.MethodDelete, adminPath, f.cookieA, "", http.StatusForbidden)
				f.call(t, http.MethodDelete, "/api/admin/supplier-dbs/"+f.sourceA, f.cookieA, "", http.StatusForbidden)
			}
			current := supplierCatalogRow(t, f.call(t, http.MethodGet, path, f.cookieA, "", http.StatusOK))
			if !current.Published || current.Archived || current.Revision != row.Revision || current.PlatformPriceCents == nil || *current.PlatformPriceCents != 1000 {
				t.Fatalf("denied action changed product: %+v", current)
			}
		})
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET role='super_admin' WHERE id=$1`, f.managerA); err != nil {
		t.Fatal(err)
	}
	assertVisible := func(want bool) {
		t.Helper()
		var catalog struct {
			Data struct {
				Rows []struct {
					ProductID string `json:"productId"`
				} `json:"rows"`
			} `json:"data"`
		}
		if err := json.Unmarshal(f.call(t, http.MethodGet, "/api/supplier-dbs/catalog", f.cookieA, "", http.StatusOK), &catalog); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, item := range catalog.Data.Rows {
			found = found || item.ProductID == row.ProductID
		}
		if found != want {
			t.Fatalf("catalog visibility = %v, want %v", found, want)
		}
	}
	assertSourceListed := func(want bool) {
		t.Helper()
		var listed bool
		if err := f.pool.QueryRow(f.ctx, `SELECT listed FROM sc_sources WHERE source_id=$1`, f.sourceA).Scan(&listed); err != nil || listed != want {
			t.Fatalf("source listed = %v, want %v, error %v", listed, want, err)
		}
	}
	assertSourceListed(false)
	f.call(t, http.MethodPost, adminPath+"/unpublish", f.cookieA, "", http.StatusOK)
	f.call(t, http.MethodPost, adminPath+"/price", f.cookieA, `{"priceCents":2000,"note":"super admin"}`, http.StatusOK)
	f.call(t, http.MethodPost, adminPath+"/publish", f.cookieA, "", http.StatusOK)
	assertSourceListed(true)
	assertVisible(true)
	f.call(t, http.MethodPut, "/api/admin/supplier-dbs/"+f.sourceA, f.cookieA, `{"name":"Renamed","country":"","contact":"","internalNote":"","icon":"","template":null,"viewPrefs":{}}`, http.StatusOK)
	assertSourceListed(true)
	assertVisible(true)
	current := supplierCatalogRow(t, f.call(t, http.MethodGet, path, f.cookieA, "", http.StatusOK))
	if !current.Published || current.PlatformPriceCents == nil || *current.PlatformPriceCents != 2000 {
		t.Fatalf("super admin changes did not persist: %+v", current)
	}
	f.call(t, http.MethodPost, adminPath+"/unpublish", f.cookieA, "", http.StatusOK)
	assertVisible(false)
	if _, err := f.pool.Exec(f.ctx, `UPDATE sc_sources SET listed=false WHERE source_id=$1`, f.sourceA); err != nil {
		t.Fatal(err)
	}
	f.call(t, http.MethodPost, path+"/publish", f.cookieA, "", http.StatusOK)
	assertSourceListed(true)
	assertVisible(true)
	f.assertRole(t)
}
