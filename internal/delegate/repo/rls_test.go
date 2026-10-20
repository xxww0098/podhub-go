package delegaterepo

import (
	"context"
	"testing"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestDispatchRLS(t *testing.T) {
	pool, ctx := parityDB(t)
	sellerA := int64(880101)
	sellerB := int64(880102)
	memberA := int64(880103)
	memberB := int64(880104)
	orgA := seedOrg(t, ctx, pool, sellerA, "rls-a")
	orgB := seedOrg(t, ctx, pool, sellerB, "rls-b")
	seedUser(t, ctx, pool, memberA, "rls-ma")
	seedUser(t, ctx, pool, memberB, "rls-mb")
	sourceA := "src_rls_a"
	sourceB := "src_rls_b"
	seedSource(t, ctx, pool, sourceA, "rls-a")
	seedSource(t, ctx, pool, sourceB, "rls-b")
	seedMember(t, ctx, pool, sourceA, memberA, "active")
	seedMember(t, ctx, pool, sourceB, memberB, "active")
	t.Cleanup(func() {
		cleanupDelegate(t, context.Background(), pool, orgA, sellerA, sourceA)
		cleanupDelegate(t, context.Background(), pool, orgB, sellerB, sourceB)
		cleanupDelegate(t, context.Background(), pool, 0, memberA, "")
		cleanupDelegate(t, context.Background(), pool, 0, memberB, "")
	})
	ready := true
	_, dispatchA := seedPacket(t, ctx, pool, orgA, sellerA, sourceA, "dispatched", "dispatched", &ready)
	_, dispatchB := seedPacket(t, ctx, pool, orgB, sellerB, sourceB, "dispatched", "dispatched", &ready)
	repo := New(pool, tenant.BeginApp)

	gotA, err := repo.ListDispatches(ctx, orgA, 0)
	if err != nil || !onlyDispatch(gotA, dispatchA) {
		t.Fatalf("org A %+v %v", gotA, err)
	}
	gotB, err := repo.ListDispatches(ctx, orgB, 0)
	if err != nil || !onlyDispatch(gotB, dispatchB) {
		t.Fatalf("org B %+v %v", gotB, err)
	}
	gotSA, err := repo.ListDispatches(ctx, 0, memberA)
	if err != nil || !onlyDispatch(gotSA, dispatchA) {
		t.Fatalf("supplier A %+v %v", gotSA, err)
	}
	gotSB, err := repo.ListDispatches(ctx, 0, memberB)
	if err != nil || !onlyDispatch(gotSB, dispatchB) {
		t.Fatalf("supplier B %+v %v", gotSB, err)
	}
	both, err := repo.ListDispatches(ctx, orgB, memberA)
	if err != nil || len(both) != 2 {
		t.Fatalf("or policies %+v %v", both, err)
	}
	if _, err := repo.ListDispatches(ctx, 0, 0); err != contract.ErrNoTenant {
		t.Fatalf("missing tenant %v", err)
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
	if err := bare.QueryRow(ctx, `SELECT count(*) FROM delegate_dispatches`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("missing GUC sees %d %v", n, err)
	}
	_, err = bare.Exec(ctx, `
		INSERT INTO delegate_orders (org_id, store_id, posting_number, state, created_at_ms, updated_at_ms)
		VALUES ($1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'x', 'ready', 1, 1)`, orgA)
	if err == nil {
		t.Fatal("missing GUC inserted an order")
	}

	txA, err := tenant.BeginApp(ctx, pool.Begin, orgA)
	if err != nil {
		t.Fatal(err)
	}
	defer txA.Rollback(ctx)
	_, err = txA.Exec(ctx, `
		INSERT INTO delegate_orders (org_id, store_id, posting_number, state, created_at_ms, updated_at_ms)
		VALUES ($1, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'y', 'ready', 1, 1)`, orgB)
	if err == nil {
		t.Fatal("org A inserted org B's order")
	}
}

func onlyDispatch(rows []contract.DispatchView, id string) bool {
	return len(rows) == 1 && rows[0].DispatchID == id && rows[0].State == "dispatched"
}
