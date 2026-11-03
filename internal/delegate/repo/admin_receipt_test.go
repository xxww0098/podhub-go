package delegaterepo

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/delegate/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

func TestAdminReceiptPersistsAndSettlesOnce(t *testing.T) {
	f := newAuthorityFixture(t)
	seedDelegateLease(t, f.ctx, f.pool, "admin")
	order, dispatch := seedPacket(t, f.ctx, f.pool, f.org, f.owner, f.source, "in_production", "accepted", nil)
	f.exec(t, `UPDATE delegate_orders SET store_id=$2::uuid WHERE order_id=$1::uuid`, order, f.store)
	f.exec(t, `INSERT INTO workspace_wallets (org_id,balance_microfen,held_microfen) VALUES ($1,10000000,0)
		ON CONFLICT (org_id) DO UPDATE SET balance_microfen=10000000,held_microfen=0`, f.org)
	if err := db.InTx(f.ctx, f.pool, db.App(f.org), func(tx pgx.Tx) error {
		return holdSeller(f.ctx, tx, f.org, domain.SellerKey(dispatch), 1000000)
	}); err != nil {
		t.Fatal(err)
	}
	f.exec(t, `INSERT INTO delegate_settlements
		(org_id,order_id,dispatch_id,source_id,amount_cents,amount_microfen,state,breakdown,held_at_ms)
		VALUES ($1,$2::uuid,$3::uuid,$4,1,1000000,'held','[]'::jsonb,1)`, f.org, order, dispatch, f.source)
	now := time.Now().UnixMilli()
	body, err := f.repo.Receipt(f.ctx, domain.AdminCommand{OrderID: order, UserID: f.owner, NowMS: now},
		domain.ReceiptInput{TrackingNo: "TRACK-REGRESSION", Note: "arrived"})
	if err != nil {
		t.Fatalf("valid receipt failed: %v", err)
	}
	if !strings.Contains(string(body), "TRACK-REGRESSION") {
		t.Fatalf("receipt missing from returned detail: %s", body)
	}
	var state, tracking, settlement string
	var balance, held, supplier int64
	if err := f.pool.QueryRow(f.ctx, `SELECT d.state,d.receipt->>'tracking_no',s.state,
		w.balance_microfen,w.held_microfen,sw.balance_microfen
		FROM delegate_dispatches d JOIN delegate_settlements s USING(dispatch_id)
		JOIN workspace_wallets w ON w.org_id=d.org_id
		JOIN supplier_wallets sw ON sw.source_id=d.source_id WHERE d.dispatch_id=$1::uuid`, dispatch).
		Scan(&state, &tracking, &settlement, &balance, &held, &supplier); err != nil {
		t.Fatal(err)
	}
	if state != "shipped" || tracking != "TRACK-REGRESSION" || settlement != "settled" || balance != 9000000 || held != 0 || supplier != 1000000 {
		t.Fatalf("receipt not settled atomically: state=%s tracking=%s settlement=%s balance=%d held=%d supplier=%d", state, tracking, settlement, balance, held, supplier)
	}
	_, err = f.repo.Receipt(f.ctx, domain.AdminCommand{OrderID: order, UserID: f.owner, NowMS: now + 1}, domain.ReceiptInput{TrackingNo: "RETRY"})
	assertDelegateStatus(t, err, 409)
	var debits, credits, audits int
	if err := f.pool.QueryRow(context.Background(), `SELECT
		(SELECT count(*) FROM wallet_ledger WHERE org_id=$1 AND entry_type='settle'),
		(SELECT count(*) FROM supplier_wallet_ledger WHERE source_id=$2 AND entry_type='credit'),
		(SELECT count(*) FROM audit_logs WHERE org_id=$1 AND action='delegate_receipt_recorded_by_admin')`, f.org, f.source).
		Scan(&debits, &credits, &audits); err != nil {
		t.Fatal(err)
	}
	if debits != 1 || credits != 1 || audits != 1 {
		t.Fatalf("receipt replay produced duplicates: debits=%d credits=%d audits=%d", debits, credits, audits)
	}
}
