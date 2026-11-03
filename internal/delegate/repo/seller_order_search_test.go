package delegaterepo

import (
	"testing"

	delegatesvc "github.com/xxww0098/podhub-go/internal/delegate/service"
)

func TestSellerOrderSearchRespectsScopeAndCursor(t *testing.T) {
	f := newAuthorityFixture(t)
	other := newAuthorityFixture(t)
	f.exec(t, `UPDATE sc_sources SET name='华南 Alpha% 工厂' WHERE source_id=$1`, f.source)
	other.exec(t, `UPDATE sc_sources SET name='北方 Alpha% 工厂' WHERE source_id=$1`, other.source)
	bound := false
	first, _ := seedPacket(t, f.ctx, f.pool, f.org, f.owner, f.source, "ready", "", &bound)
	second, _ := seedPacket(t, f.ctx, f.pool, f.org, f.owner, f.source, "ready", "", &bound)
	unbound, _ := seedPacket(t, f.ctx, f.pool, f.org, f.owner, f.source, "ready", "", nil)
	foreign, _ := seedPacket(t, other.ctx, other.pool, other.org, other.owner, other.source, "ready", "", &bound)
	for _, row := range []struct {
		order, store, posting string
		at                    int64
	}{
		{first, f.store, "ABC-001", 300},
		{second, f.store, "ABC-002", 200},
		{unbound, f.store, "XYZ-003", 100},
		{foreign, other.store, "ABC-FOREIGN", 400},
	} {
		f.exec(t, `UPDATE delegate_orders SET store_id=$2::uuid, posting_number=$3, created_at_ms=$4 WHERE order_id=$1::uuid`, row.order, row.store, row.posting, row.at)
	}

	svc := delegatesvc.Seller{DB: f.repo}
	actor := delegatesvc.Actor{OrgID: f.org, UserID: f.owner, CanManage: true}
	limit := int64(1)
	rows, hasNext, cursor, err := svc.Orders(f.ctx, actor, f.store, "ready", "  alpha%  ", "", &limit)
	if err != nil || len(rows) != 1 || rows[0].OrderID != first || !hasNext || cursor == "" {
		t.Fatalf("first page=%v hasNext=%v cursor=%q error=%v", rows, hasNext, cursor, err)
	}
	rows, hasNext, _, err = svc.Orders(f.ctx, actor, f.store, "ready", "alpha%", cursor, &limit)
	if err != nil || len(rows) != 1 || rows[0].OrderID != second || hasNext {
		t.Fatalf("second page=%v hasNext=%v error=%v", rows, hasNext, err)
	}
	rows, _, _, err = svc.Orders(f.ctx, actor, f.store, "", "xyz-003", "", nil)
	if err != nil || len(rows) != 1 || rows[0].OrderID != unbound {
		t.Fatalf("posting search=%v error=%v", rows, err)
	}
	rows, _, _, err = svc.Orders(f.ctx, actor, f.store, "", "%", "", nil)
	if err != nil || len(rows) != 2 {
		t.Fatalf("literal percent search=%v error=%v", rows, err)
	}
	rows, _, _, err = svc.Orders(f.ctx, actor, f.store, "shipped", "alpha%", "", nil)
	if err != nil || len(rows) != 0 {
		t.Fatalf("state filter=%v error=%v", rows, err)
	}
}
