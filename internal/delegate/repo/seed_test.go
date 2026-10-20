package delegaterepo

import (
	"context"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type lineSpec struct {
	ready  *bool
	packet string
}

func seedUser(t testing.TB, ctx context.Context, pool *pgxpool.Pool, userID int64, tag string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'user', 't', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())
		ON CONFLICT (id) DO NOTHING`, userID, fmt.Sprintf("d%d", userID), fmt.Sprintf("d%d@example.invalid", userID)); err != nil {
		t.Fatal(err)
	}
}

func seedOrg(t testing.TB, ctx context.Context, pool *pgxpool.Pool, userID int64, tag string) int64 {
	t.Helper()
	seedUser(t, ctx, pool, userID, tag)
	var orgID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, $2, 'lite', clock_timestamp(), clock_timestamp()) RETURNING id`,
		userID, "org-"+tag+"-"+fmt.Sprint(userID)).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1, $2, 'owner', 'active', 't', clock_timestamp(), clock_timestamp(), 1)`, orgID, userID); err != nil {
		t.Fatal(err)
	}
	return orgID
}

func seedSource(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sourceID, name string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_sources (source_id, name, created_at_ms, updated_at_ms)
		VALUES ($1, $2, 1, 1)`, sourceID, name); err != nil {
		t.Fatal(err)
	}
}

func seedMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sourceID string, userID int64, status string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_source_members (source_id, user_id, status, created_by, created_at_ms)
		VALUES ($1, $2, $3, $2, 1)`, sourceID, userID, status); err != nil {
		t.Fatal(err)
	}
}

func seedOrder(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, sourceID, state string, lines []lineSpec) string {
	t.Helper()
	orderID, _ := seedPacketLines(t, ctx, pool, orgID, userID, sourceID, state, lines)
	return orderID
}

func seedPacket(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, sourceID, orderState, packet string, ready *bool) (string, string) {
	t.Helper()
	return seedPacketLines(t, ctx, pool, orgID, userID, sourceID, orderState, []lineSpec{{ready: ready, packet: packet}})
}

func seedPacketLines(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, sourceID, state string, lines []lineSpec) (string, string) {
	t.Helper()
	var orderID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO delegate_orders (org_id, store_id, posting_number, state, created_at_ms, updated_at_ms)
		VALUES ($1, $2, $3, $4, 1, 1) RETURNING order_id::text`,
		orgID, uuid.NewString(), "post-"+uuid.NewString(), state).Scan(&orderID); err != nil {
		t.Fatal(err)
	}
	var lastDispatch string
	for i, line := range lines {
		var binding any
		if line.ready != nil {
			var bindingID string
			if err := pool.QueryRow(ctx, `
				INSERT INTO delegate_bindings (org_id, store_id, offer_id, source_id, active, created_by, created_at_ms, updated_at_ms)
				VALUES ($1, $2, $3, $4, $5, $6, 1, 1) RETURNING binding_id::text`,
				orgID, uuid.NewString(), "offer-"+uuid.NewString(), sourceID, *line.ready, userID).Scan(&bindingID); err != nil {
				t.Fatal(err)
			}
			if *line.ready {
				if _, err := pool.Exec(ctx, `
					INSERT INTO delegate_assets (org_id, binding_id, object_key, sha256, bytes, mime, file_name, verified_at_ms, created_at_ms)
					VALUES ($1, $2, $3, $4, 10, 'image/png', 'a.png', 1, 1)`,
					orgID, bindingID, "key-"+uuid.NewString(), "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"); err != nil {
					t.Fatal(err)
				}
			}
			binding = bindingID
		}
		var lineID string
		if err := pool.QueryRow(ctx, `
			INSERT INTO delegate_order_lines (org_id, order_id, offer_id, quantity, binding_id)
			VALUES ($1, $2, $3, 1, $4) RETURNING line_id::text`,
			orgID, orderID, fmt.Sprintf("line-%d-%s", i, uuid.NewString()), binding).Scan(&lineID); err != nil {
			t.Fatal(err)
		}
		if line.packet == "" {
			continue
		}
		if err := pool.QueryRow(ctx, `
			INSERT INTO delegate_dispatches (org_id, order_id, source_id, dispatch_no, payload, state, created_at_ms, updated_at_ms)
			VALUES ($1, $2, $3, $4, jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('line_id', $5::text))), $6, $7, $7)
			RETURNING dispatch_id::text`,
			orgID, orderID, sourceID, "no-"+uuid.NewString(), lineID, line.packet, i+1).Scan(&lastDispatch); err != nil {
			t.Fatal(err)
		}
	}
	return orderID, lastDispatch
}

func cleanupDelegate(t testing.TB, ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, sourceID string) {
	t.Helper()
	if orgID > 0 {
		_, _ = pool.Exec(ctx, `DELETE FROM delegate_dispatch_assets WHERE org_id = $1`, orgID)
		_, _ = pool.Exec(ctx, `DELETE FROM delegate_dispatches WHERE org_id = $1`, orgID)
		_, _ = pool.Exec(ctx, `DELETE FROM delegate_assets WHERE org_id = $1`, orgID)
		_, _ = pool.Exec(ctx, `DELETE FROM delegate_order_lines WHERE org_id = $1`, orgID)
		_, _ = pool.Exec(ctx, `DELETE FROM delegate_orders WHERE org_id = $1`, orgID)
		_, _ = pool.Exec(ctx, `DELETE FROM delegate_bindings WHERE org_id = $1`, orgID)
		_, _ = pool.Exec(ctx, `DELETE FROM organization_members WHERE org_id = $1`, orgID)
		_, _ = pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)
	}
	if sourceID != "" {
		_, _ = pool.Exec(ctx, `DELETE FROM sc_source_members WHERE source_id = $1`, sourceID)
		_, _ = pool.Exec(ctx, `DELETE FROM supplier_wallets WHERE source_id = $1`, sourceID)
		_, _ = pool.Exec(ctx, `DELETE FROM supplier_withdrawals WHERE source_id = $1`, sourceID)
		_, _ = pool.Exec(ctx, `DELETE FROM sc_sources WHERE source_id = $1`, sourceID)
	}
	if userID > 0 {
		_, _ = pool.Exec(ctx, `DELETE FROM account_users WHERE id = $1`, userID)
	}
}
