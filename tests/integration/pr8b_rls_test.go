package integration

import (
	"context"
	"strings"
	"testing"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestPR8BTenantIsolation(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	userA, orgA := insertWorkspace(t, ctx, pool, "pr8b-a@example.com", "pr8b-a")
	userB, orgB := insertWorkspace(t, ctx, pool, "pr8b-b@example.com", "pr8b-b")
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM public.browser_commands WHERE client_request_id LIKE 'pr8b-%'`)
		_, _ = pool.Exec(context.Background(), `DELETE FROM public.automation_grants WHERE name LIKE 'pr8b-%'`)
		_, _ = pool.Exec(context.Background(), `DELETE FROM public.event_inbox_events WHERE device_uid = 'pr8b'`)
	})

	if _, err := pool.Exec(ctx, `
		INSERT INTO public.browser_commands (org_id, user_id, grant_id, client_request_id, action, payload)
		VALUES
			($1, $2, '11111111-1111-4111-8111-111111111111', 'pr8b-a', 'assets_import', '{}'::jsonb),
			($3, $4, '22222222-2222-4222-8222-222222222222', 'pr8b-b', 'listing_prepare', '{}'::jsonb)`,
		orgA, userA, orgB, userB); err != nil {
		t.Fatal(err)
	}

	txA, err := tenant.BeginApp(ctx, pool.Begin, orgA)
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := txA.QueryRow(ctx, `SELECT count(*) FROM public.browser_commands WHERE client_request_id LIKE 'pr8b-%'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("org A sees %d %v", n, err)
	}
	tag, err := txA.Exec(ctx, `UPDATE public.browser_commands SET status = 'claimed' WHERE org_id = $1`, orgB)
	if err != nil || tag.RowsAffected() != 0 {
		t.Fatalf("cross-tenant update %v %d", err, tag.RowsAffected())
	}
	_, err = txA.Exec(ctx, `
		INSERT INTO public.browser_commands (org_id, user_id, grant_id, client_request_id, action, payload)
		VALUES ($1, $2, '33333333-3333-4333-8333-333333333333', 'pr8b-cross', 'assets_import', '{}'::jsonb)`, orgB, userB)
	if err == nil {
		t.Fatal("org A inserted org B's command")
	}
	_ = txA.Rollback(ctx)

	bare, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bare.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	if err := bare.QueryRow(ctx, `SELECT count(*) FROM public.browser_commands WHERE client_request_id LIKE 'pr8b-%'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("missing GUC sees %d %v", n, err)
	}
	_, err = bare.Exec(ctx, `
		INSERT INTO public.browser_commands (org_id, user_id, grant_id, client_request_id, action, payload)
		VALUES ($1, $2, '44444444-4444-4444-8444-444444444444', 'pr8b-noguc', 'assets_import', '{}'::jsonb)`, orgA, userA)
	if err == nil {
		t.Fatal("missing GUC inserted a command")
	}
	_ = bare.Rollback(ctx)

	if _, err := pool.Exec(ctx, `
		INSERT INTO public.automation_grants (user_id, org_id, name, token_hash, token_prefix, actions)
		VALUES ($1, $2, 'pr8b-a', 'pr8b-hash-a', 'opa_pr8b_a', ARRAY['read']::text[]),
		       ($3, $4, 'pr8b-b', 'pr8b-hash-b', 'opa_pr8b_b', ARRAY['prepare']::text[])`,
		userA, orgA, userB, orgB); err != nil {
		t.Fatal(err)
	}
	gap, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := gap.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	if err := gap.QueryRow(ctx, `SELECT count(*) FROM public.automation_grants WHERE name LIKE 'pr8b-%'`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("grants have no RLS, podhub_app without GUC sees %d %v", n, err)
	}
	_, err = gap.Exec(ctx, `UPDATE public.automation_grants SET token_hash = 'changed' WHERE name = 'pr8b-a'`)
	if err == nil || !strings.Contains(err.Error(), "automation grant authority is immutable") {
		t.Fatalf("authority trigger: %v", err)
	}
	_ = gap.Rollback(ctx)

	if _, err := pool.Exec(ctx, `
		INSERT INTO public.event_inbox_events (device_uid, id, org_id, user_id, kind, payload_json, client_created_at, received_at)
		VALUES ('pr8b', 'a', $1, $2, 'kind', '{}', 't', clock_timestamp()),
		       ('pr8b', 'b', $3, $4, 'kind', '{}', 't', clock_timestamp())`,
		orgA, userA, orgB, userB); err != nil {
		t.Fatal(err)
	}
	inbox, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := inbox.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	err = inbox.QueryRow(ctx, `SELECT count(*) FROM public.event_inbox_events WHERE device_uid = 'pr8b'`).Scan(&n)
	switch {
	case err != nil && strings.Contains(err.Error(), "permission denied"):
		// Baseline never GRANTs this table to podhub_app. That is not RLS.
	case err != nil || n != 2:
		t.Fatalf("event inbox without GUC: n=%d err=%v", n, err)
	}
	_ = inbox.Rollback(ctx)
}
