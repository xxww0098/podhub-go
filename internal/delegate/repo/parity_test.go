package delegaterepo

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/delegate/domain"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestRecomputeMatchesSQLFunction(t *testing.T) {
	pool, ctx := parityDB(t)
	userID := int64(880001)
	orgID := seedOrg(t, ctx, pool, userID, "recompute")
	sourceID := "src_recompute_880001"
	seedSource(t, ctx, pool, sourceID, "recompute-880001")
	t.Cleanup(func() { cleanupDelegate(t, context.Background(), pool, orgID, userID, sourceID) })

	readyTrue, readyFalse := true, false
	cases := []struct {
		name    string
		current string
		lines   []lineSpec
	}{
		{name: "no lines", current: "ready"},
		{name: "done stays done", current: "done"},
		{name: "cancelled stays cancelled", current: "cancelled", lines: []lineSpec{{ready: &readyTrue, packet: "shipped"}}},
		{name: "null ready", current: "awaiting_setup", lines: []lineSpec{{packet: ""}}},
		{name: "unready", current: "ready", lines: []lineSpec{{ready: &readyFalse}}},
		{name: "ready", current: "awaiting_setup", lines: []lineSpec{{ready: &readyTrue}}},
		{name: "dispatched", current: "ready", lines: []lineSpec{{ready: &readyTrue, packet: "dispatched"}}},
		{name: "accepted", current: "dispatched", lines: []lineSpec{{ready: &readyTrue, packet: "accepted"}}},
		{name: "shipped", current: "in_production", lines: []lineSpec{{ready: &readyTrue, packet: "shipped"}}},
		{name: "rejected null ready", current: "dispatched", lines: []lineSpec{{packet: "rejected"}}},
		{name: "mixed", current: "dispatched", lines: []lineSpec{{ready: &readyTrue, packet: "shipped"}, {ready: &readyTrue, packet: "dispatched"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			orderID := seedOrder(t, ctx, pool, orgID, userID, sourceID, tc.current, tc.lines)
			var returned string
			if err := pool.QueryRow(ctx, `SELECT public.delegate_supplier_recompute_order_state($1::uuid, 42)`, orderID).Scan(&returned); err != nil {
				t.Fatal(err)
			}
			var stored string
			if err := pool.QueryRow(ctx, `SELECT state FROM delegate_orders WHERE order_id = $1`, orderID).Scan(&stored); err != nil {
				t.Fatal(err)
			}
			lines := make([]domain.Line, len(tc.lines))
			for i, line := range tc.lines {
				lines[i] = domain.Line{Ready: line.ready, Packet: line.packet}
			}
			if returned != domain.ComputeOrderState(lines) {
				t.Fatalf("return %s want %s", returned, domain.ComputeOrderState(lines))
			}
			if stored != domain.StoredOrderState(tc.current, lines) {
				t.Fatalf("stored %s want %s", stored, domain.StoredOrderState(tc.current, lines))
			}
		})
	}
}

func TestDispatchActionsMatchSQLFunction(t *testing.T) {
	pool, ctx := parityDB(t)
	member := int64(880011)
	other := int64(880012)
	orgID := seedOrg(t, ctx, pool, member, "actions")
	seedUser(t, ctx, pool, other, "actions-other")
	sourceID := "src_actions_880011"
	seedSource(t, ctx, pool, sourceID, "actions-880011")
	seedMember(t, ctx, pool, sourceID, member, "active")
	seedMember(t, ctx, pool, sourceID, other, "disabled")
	t.Cleanup(func() {
		cleanupDelegate(t, context.Background(), pool, orgID, member, sourceID)
		cleanupDelegate(t, context.Background(), pool, 0, other, "")
	})
	repo := New(pool, tenant.BeginApp)
	readyFalse := false

	t.Run("accept then idempotent", func(t *testing.T) {
		orderID, dispatchID := seedPacket(t, ctx, pool, orgID, member, sourceID, "dispatched", "dispatched", &readyFalse)
		state, err := repo.Accept(ctx, 0, member, dispatchID)
		if err != nil || state != "accepted" {
			t.Fatalf("accept %s %v", state, err)
		}
		assertOrder(t, ctx, pool, orderID, "in_production")
		state, err = repo.Accept(ctx, 0, member, dispatchID)
		if err != nil || state != "accepted" {
			t.Fatalf("replay %s %v", state, err)
		}
		assertOrder(t, ctx, pool, orderID, "in_production")
		var receipt *string
		if err := pool.QueryRow(ctx, `SELECT receipt::text FROM delegate_dispatches WHERE dispatch_id = $1`, dispatchID).Scan(&receipt); err != nil {
			t.Fatal(err)
		}
		if receipt != nil {
			t.Fatalf("accept wrote receipt %s", *receipt)
		}
	})

	t.Run("reject latches the line", func(t *testing.T) {
		_, dispatchID := seedPacket(t, ctx, pool, orgID, member, sourceID, "dispatched", "dispatched", &readyFalse)
		state, err := repo.Reject(ctx, 0, member, dispatchID, "no stock")
		if err != nil || state != "rejected" {
			t.Fatalf("reject %s %v", state, err)
		}
		var reason, latched string
		if err := pool.QueryRow(ctx, `SELECT receipt->>'reason' FROM delegate_dispatches WHERE dispatch_id = $1`, dispatchID).Scan(&reason); err != nil {
			t.Fatal(err)
		}
		if reason != "no stock" {
			t.Fatalf("reason %s", reason)
		}
		if err := pool.QueryRow(ctx, `
			SELECT l.last_rejected_source_id FROM delegate_order_lines l
			JOIN delegate_dispatches d ON d.order_id = l.order_id
			WHERE d.dispatch_id = $1`, dispatchID).Scan(&latched); err != nil {
			t.Fatal(err)
		}
		if latched != sourceID {
			t.Fatalf("latch %s", latched)
		}
		if _, err := repo.Reject(ctx, 0, member, dispatchID, "again"); err != contract.ErrTerminal {
			t.Fatalf("second reject %v", err)
		}
	})

	t.Run("ship from accepted", func(t *testing.T) {
		orderID, dispatchID := seedPacket(t, ctx, pool, orgID, member, sourceID, "dispatched", "dispatched", &readyFalse)
		if _, err := repo.Accept(ctx, 0, member, dispatchID); err != nil {
			t.Fatal(err)
		}
		state, err := repo.Ship(ctx, 0, member, dispatchID, "TRACK", "note", 99)
		if err != nil || state != "shipped" {
			t.Fatalf("ship %s %v", state, err)
		}
		assertOrder(t, ctx, pool, orderID, "shipped")
		var tracking, note string
		var at int64
		if err := pool.QueryRow(ctx, `
			SELECT receipt->>'tracking_no', receipt->>'note', (receipt->>'at_ms')::bigint
			FROM delegate_dispatches WHERE dispatch_id = $1`, dispatchID).Scan(&tracking, &note, &at); err != nil {
			t.Fatal(err)
		}
		if tracking != "TRACK" || note != "note" || at != 99 {
			t.Fatalf("receipt %s %s %d", tracking, note, at)
		}
		if _, err := repo.Ship(ctx, 0, member, dispatchID, "TRACK", "note", 100); err != contract.ErrTerminal {
			t.Fatalf("second ship %v", err)
		}
	})

	t.Run("ship before accept is terminal", func(t *testing.T) {
		_, dispatchID := seedPacket(t, ctx, pool, orgID, member, sourceID, "dispatched", "dispatched", &readyFalse)
		if _, err := repo.Ship(ctx, 0, member, dispatchID, "T", "", 1); err != contract.ErrTerminal {
			t.Fatal(err)
		}
	})

	t.Run("cancelled order", func(t *testing.T) {
		_, dispatchID := seedPacket(t, ctx, pool, orgID, member, sourceID, "cancelled", "dispatched", &readyFalse)
		if _, err := repo.Accept(ctx, 0, member, dispatchID); err != contract.ErrTerminal {
			t.Fatal(err)
		}
	})

	t.Run("disabled member", func(t *testing.T) {
		_, dispatchID := seedPacket(t, ctx, pool, orgID, member, sourceID, "dispatched", "dispatched", &readyFalse)
		if _, err := repo.Accept(ctx, 0, other, dispatchID); err != contract.ErrForbidden {
			t.Fatal(err)
		}
	})

	t.Run("missing dispatch", func(t *testing.T) {
		if _, err := repo.Accept(ctx, 0, member, "99999999-9999-4999-8999-999999999999"); err != contract.ErrNotFound {
			t.Fatal(err)
		}
	})

	t.Run("bad uuid", func(t *testing.T) {
		if _, err := repo.Accept(ctx, 0, member, "nope"); err != contract.ErrNotFound {
			t.Fatal(err)
		}
	})
}

func assertOrder(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orderID, want string) {
	t.Helper()
	var state string
	if err := pool.QueryRow(ctx, `SELECT state FROM delegate_orders WHERE order_id = $1`, orderID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != want {
		t.Fatalf("order %s want %s", state, want)
	}
}
