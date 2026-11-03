package supplierrepo

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/supplier/contract"
)

func TestCatalogImageRequiresPublishedReference(t *testing.T) {
	pool, ctx := parityDB(t)
	var reads atomic.Int32
	jpeg := mustJPEG(t, 40, 50)
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		if r.URL.Query().Get("X-Amz-Signature") == "" {
			t.Error("object request was not signed")
		}
		w.Write(jpeg)
	}))
	defer origin.Close()
	const source, product, sku = "src_image_public", "prd_image_public", "sku_image_public"
	file := strings.Repeat("a", 64) + ".jpg"
	account := loopbackAccount(origin.URL)
	account.KeyPrefix, account.PublicBaseURL = "catalog/", origin.URL
	publicURL := origin.URL + "/catalog/supplier-dbs/" + source + "/" + file
	gallery, _ := json.Marshal([]map[string]any{{"url": publicURL, "w": 40, "h": 50}})
	if _, err := pool.Exec(ctx, `INSERT INTO sc_sources (source_id, name, listed, created_at_ms, updated_at_ms) VALUES ($1, 'image test', true, 1, 1)`, source); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM sc_skus WHERE sku_id=$1`, sku)
		_, _ = pool.Exec(context.Background(), `DELETE FROM sc_products WHERE product_id=$1`, product)
		_, _ = pool.Exec(context.Background(), `DELETE FROM sc_sources WHERE source_id=$1`, source)
	})
	if _, err := pool.Exec(ctx, `INSERT INTO sc_products (product_id, source_id, title, published, gallery, created_at_ms, updated_at_ms, created_by_account_uuid) VALUES ($1, $2, 'image test', true, $3, 1, 1, 'test')`, product, source, gallery); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_skus (sku_id, product_id, platform_code, title, published, created_at_ms, updated_at_ms, created_by_account_uuid) VALUES ($1, $2, 'IMAGE-TEST', 'image test', true, 1, 1, 'test')`, sku, product); err != nil {
		t.Fatal(err)
	}
	repo := New(pool, tenant.BeginApp).WithBlobs(nil, &account)
	got, err := repo.CatalogImage(ctx, source, file, 32)
	if err != nil || got.ContentType != "image/jpeg" {
		t.Fatalf("published image: %s %v", got.ContentType, err)
	}
	if _, _, err := image.Decode(bytes.NewReader(got.Bytes)); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, hide, restore string }{
		{"source hidden", `UPDATE sc_sources SET listed=false WHERE source_id=$1`, `UPDATE sc_sources SET listed=true WHERE source_id=$1`},
		{"product unpublished", `UPDATE sc_products SET published=false WHERE source_id=$1`, `UPDATE sc_products SET published=true WHERE source_id=$1`},
		{"product archived", `UPDATE sc_products SET archived=true WHERE source_id=$1`, `UPDATE sc_products SET archived=false WHERE source_id=$1`},
		{"sku unpublished", `UPDATE sc_skus SET published=false WHERE product_id IN (SELECT product_id FROM sc_products WHERE source_id=$1)`, `UPDATE sc_skus SET published=true WHERE product_id IN (SELECT product_id FROM sc_products WHERE source_id=$1)`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := pool.Exec(ctx, tc.hide, source); err != nil {
				t.Fatal(err)
			}
			_, err := repo.CatalogImage(ctx, source, file, 32)
			failure, ok := contract.AsFailure(err)
			if !ok || failure.Status != http.StatusNotFound || reads.Load() != 1 {
				t.Fatalf("hidden image: err=%v reads=%d", err, reads.Load())
			}
			if _, err := pool.Exec(ctx, tc.restore, source); err != nil {
				t.Fatal(err)
			}
		})
	}
	_, err = repo.CatalogImage(ctx, source, strings.Repeat("b", 64)+".jpg", 32)
	if failure, ok := contract.AsFailure(err); !ok || failure.Status != http.StatusNotFound || reads.Load() != 1 {
		t.Fatalf("unreferenced image: err=%v reads=%d", err, reads.Load())
	}
}
