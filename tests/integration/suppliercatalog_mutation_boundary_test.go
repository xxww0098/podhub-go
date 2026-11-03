package integration

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestSupplierCatalogDeleteBindsSourceAndProduct(t *testing.T) {
	f := newSupplierCatalogHTTPFixture(t)
	if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET role='super_admin' WHERE id=$1`, f.managerA); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO sc_catalog_managers (source_id,user_id,status,created_at_ms) VALUES ($1,$2,'active',1)`, f.sourceB, f.managerA); err != nil {
		t.Fatal(err)
	}
	baseB := "/api/supplier-catalog/sources/" + f.sourceB + "/rows"
	row := supplierCatalogRow(t, f.call(t, http.MethodPost, baseB, f.cookieA, `{"title":"B stays published","platformCode":"bound-b","costCents":100}`, http.StatusCreated))
	f.ready(t, row)
	f.call(t, http.MethodPost, baseB+"/"+row.ProductID+"/publish", f.cookieA, "", http.StatusOK)
	var beforeSKURevision int64
	if err := f.pool.QueryRow(f.ctx, `SELECT revision FROM sc_skus WHERE sku_id=$1`, row.SKUID).Scan(&beforeSKURevision); err != nil {
		t.Fatal(err)
	}
	wrong := "/api/supplier-catalog/sources/" + f.sourceA + "/rows/" + row.ProductID
	reply, err := f.request(http.MethodDelete, wrong, f.cookieA, "")
	if err != nil {
		t.Fatal(err)
	}
	var archived, productPublished, skuPublished bool
	var skuRevision int64
	if err := f.pool.QueryRow(f.ctx, `SELECT p.archived,p.published,s.published,s.revision FROM sc_products p JOIN sc_skus s USING(product_id) WHERE p.product_id=$1`, row.ProductID).Scan(&archived, &productPublished, &skuPublished, &skuRevision); err != nil {
		t.Fatal(err)
	}
	if reply.status != http.StatusNotFound || archived || !productPublished || !skuPublished || skuRevision != beforeSKURevision {
		t.Fatalf("mismatched delete changed another source: status=%d body=%s archived=%v productPublished=%v skuPublished=%v skuRevision=%d want=%d", reply.status, reply.body, archived, productPublished, skuPublished, skuRevision, beforeSKURevision)
	}
	f.assertRole(t)
}

func TestSupplierCatalogPublishRechecksAfterConcurrentArchive(t *testing.T) {
	f := newSupplierCatalogHTTPFixture(t)
	if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET role='super_admin' WHERE id=$1`, f.managerA); err != nil {
		t.Fatal(err)
	}
	base := "/api/supplier-catalog/sources/" + f.sourceA + "/rows"
	row := supplierCatalogRow(t, f.call(t, http.MethodPost, base, f.cookieA, `{"title":"Archive wins","platformCode":"archive-wins","costCents":100}`, http.StatusCreated))
	f.ready(t, row)
	lock, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(context.Background())
	if _, err := lock.Exec(f.ctx, `SELECT product_id FROM sc_products WHERE product_id=$1 FOR UPDATE`, row.ProductID); err != nil {
		t.Fatal(err)
	}
	blocker := lock.Conn().PgConn().PID()
	type result struct {
		reply supplierCatalogReply
		err   error
	}
	done := make(chan result, 1)
	go func() {
		reply, err := f.request(http.MethodPost, base+"/"+row.ProductID+"/publish", f.cookieA, "")
		done <- result{reply, err}
	}()
	wait, cancel := context.WithTimeout(f.ctx, 10*time.Second)
	defer cancel()
	for {
		var blocked bool
		if err := f.pool.QueryRow(wait, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%sc_products%')`, blocker).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case finished := <-done:
			t.Fatalf("publish returned before lock boundary: status=%d body=%s err=%v", finished.reply.status, finished.reply.body, finished.err)
		case <-wait.Done():
			t.Fatal("publish did not reach product write lock")
		case <-time.After(10 * time.Millisecond):
		}
	}
	// Commit the same product/SKU changes as DeleteRow while publish waits.
	if _, err := lock.Exec(f.ctx, `UPDATE sc_products SET archived=true,published=false,revision=revision+1 WHERE product_id=$1`, row.ProductID); err != nil {
		t.Fatal(err)
	}
	if _, err := lock.Exec(f.ctx, `UPDATE sc_skus SET published=false,revision=revision+1 WHERE product_id=$1`, row.ProductID); err != nil {
		t.Fatal(err)
	}
	if err := lock.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	finished := <-done
	if finished.err != nil {
		t.Fatal(finished.err)
	}
	var archived, productPublished, skuPublished bool
	if err := f.pool.QueryRow(f.ctx, `SELECT p.archived,p.published,s.published FROM sc_products p JOIN sc_skus s USING(product_id) WHERE p.product_id=$1`, row.ProductID).Scan(&archived, &productPublished, &skuPublished); err != nil {
		t.Fatal(err)
	}
	if finished.reply.status != http.StatusBadRequest || !archived || productPublished || skuPublished {
		t.Fatalf("publish used pre-archive state: status=%d body=%s archived=%v productPublished=%v skuPublished=%v", finished.reply.status, finished.reply.body, archived, productPublished, skuPublished)
	}
	f.assertRole(t)
}
