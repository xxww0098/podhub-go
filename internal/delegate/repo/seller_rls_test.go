package delegaterepo

import (
	"context"
	"testing"

	"github.com/google/uuid"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestSellerBindingsRLS(t *testing.T) {
	pool, ctx := parityDB(t)
	userA := int64(881201)
	userB := int64(881202)
	orgA := seedOrg(t, ctx, pool, userA, "sell-a")
	orgB := seedOrg(t, ctx, pool, userB, "sell-b")
	source := "src_seller_rls"
	seedSource(t, ctx, pool, source, "seller-rls")
	t.Cleanup(func() {
		cleanupDelegate(t, context.Background(), pool, orgA, userA, source)
		cleanupDelegate(t, context.Background(), pool, orgB, userB, "")
	})
	storeA := uuid.NewString()
	storeB := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO delegate_bindings (org_id, store_id, offer_id, source_id, active, created_by, created_at_ms, updated_at_ms)
		VALUES ($1, $2, 'OFFER-A', $3, true, $4, 1, 1),
		       ($5, $6, 'OFFER-B', $3, true, $7, 2, 2)`,
		orgA, storeA, source, userA, orgB, storeB, userB); err != nil {
		t.Fatal(err)
	}
	repo := New(pool, tenant.BeginApp)
	rows, err := repo.ListBindings(ctx, orgA, storeA)
	if err != nil || len(rows) != 1 || rows[0].OfferID != "OFFER-A" {
		t.Fatalf("org A %+v %v", rows, err)
	}
	other, err := repo.ListBindings(ctx, orgA, storeB)
	if err != nil || len(other) != 0 {
		t.Fatalf("cross store %+v %v", other, err)
	}
	bare, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer bare.Rollback(ctx)
	if _, err := bare.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := bare.QueryRow(ctx, `SELECT count(*) FROM delegate_bindings`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("missing GUC sees %d %v", n, err)
	}
}
