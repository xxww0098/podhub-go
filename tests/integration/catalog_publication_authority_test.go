package integration

import (
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
	f.call(t, http.MethodPost, adminPath+"/unpublish", f.cookieA, "", http.StatusOK)
	f.call(t, http.MethodPost, adminPath+"/price", f.cookieA, `{"priceCents":2000,"note":"super admin"}`, http.StatusOK)
	f.call(t, http.MethodPost, adminPath+"/publish", f.cookieA, "", http.StatusOK)
	current := supplierCatalogRow(t, f.call(t, http.MethodGet, path, f.cookieA, "", http.StatusOK))
	if !current.Published || current.PlatformPriceCents == nil || *current.PlatformPriceCents != 2000 {
		t.Fatalf("super admin changes did not persist: %+v", current)
	}
	f.assertRole(t)
}
