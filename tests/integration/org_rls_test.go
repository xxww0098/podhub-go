package integration

import (
	"context"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// TestOrgScopeTablesForceRLS covers the org-scoped directory, credential,
// supply, shipping and support tables. Every table must have both ENABLE and
// FORCE row security plus the tenant and staff policies from
// 00024_org_scope_rls.sql.
func TestOrgScopeTablesForceRLS(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	tables := []string{
		"organization_stores", "organization_members", "org_invitations",
		"organization_store_groups", "organization_store_tags", "store_tag_links",
		"store_tombstone_consumptions", "store_seller_credentials",
		"store_credential_verifications", "sc_listing_bindings", "sc_order_quotes",
		"sc_procurements", "shipping_inject_operations", "shipping_shop_injections",
		"support_grants",
	}
	for _, table := range tables {
		var enabled, forced bool
		if err := pool.QueryRow(ctx, "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace", table).Scan(&enabled, &forced); err != nil {
			t.Fatalf("read pg_class for %s: %v", table, err)
		}
		if !enabled || !forced {
			t.Fatalf("%s: rls enabled=%v forced=%v, want both true", table, enabled, forced)
		}
		var policies int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND policyname IN ('tenant_isolation', 'staff_all')", table).Scan(&policies); err != nil {
			t.Fatalf("read policies for %s: %v", table, err)
		}
		if policies != 2 {
			t.Fatalf("%s: tenant/staff policy count=%d, want 2", table, policies)
		}
	}
	// 00025 adds the staff arm to the admin procurement order tables; they keep
	// their existing tenant and worker policies on top of it.
	for _, table := range []string{"sc_orders", "sc_order_lines"} {
		var policies int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND policyname = 'staff_all'", table).Scan(&policies); err != nil {
			t.Fatalf("read staff policy for %s: %v", table, err)
		}
		if policies != 1 {
			t.Fatalf("%s: staff_all policy count=%d, want 1", table, policies)
		}
	}
}

// TestOrgStoresRLSIsolatesOrgs proves the policy is not merely present: a
// request-role session sees only its current org's store and cannot insert a
// row for another org.
func TestOrgStoresRLSIsolatesOrgs(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	const orgA, orgB = int64(960001), int64(960002)
	const userA, userB = int64(960011), int64(960012)
	seedAccount(t, ctx, pool, userA, "org-rls-a@test.example", "user", "platform")
	seedAccount(t, ctx, pool, userB, "org-rls-b@test.example", "user", "platform")
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM organization_stores WHERE org_id IN ($1, $2)", orgA, orgB)
		_, _ = pool.Exec(context.Background(), "DELETE FROM organizations WHERE id IN ($1, $2)", orgA, orgB)
		_, _ = pool.Exec(context.Background(), "DELETE FROM account_users WHERE id IN ($1, $2)", userA, userB)
	})
	if _, err := pool.Exec(ctx, "INSERT INTO organizations (id, owner_user_id, name, plan, created_at, updated_at) VALUES ($1, $2, 'rls-a', 'free', clock_timestamp(), clock_timestamp()), ($3, $4, 'rls-b', 'free', clock_timestamp(), clock_timestamp())", orgA, userA, orgB, userB); err != nil {
		t.Fatalf("insert organizations: %v", err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO organization_stores (id, org_id, uuid, create_order, name) VALUES (960101, $1, '00000000-0000-0000-0000-000009600101', 1, 'store-a'), (960102, $2, '00000000-0000-0000-0000-000009600102', 1, 'store-b')", orgA, orgB); err != nil {
		t.Fatalf("insert stores: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := tenantx.EnterApp(ctx, tx, orgA); err != nil {
		t.Fatal(err)
	}
	var seen int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM organization_stores WHERE org_id IN ($1, $2)", orgA, orgB).Scan(&seen); err != nil {
		t.Fatalf("org store RLS read: %v", err)
	}
	if seen != 1 {
		t.Fatalf("org A sees %d stores, want 1", seen)
	}
	if _, err := tx.Exec(ctx, "INSERT INTO organization_stores (id, org_id, uuid, create_order, name) VALUES (960103, $1, '00000000-0000-0000-0000-000009600103', 1, 'cross-org')", orgB); err == nil {
		t.Fatal("org A inserted a store for org B under RLS")
	}
}
