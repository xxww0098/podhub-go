package integration

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestNewAPIBillingLogsRLS(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	userA, orgA := insertWorkspace(t, ctx, pool, "n1log-a@example.com", "n1log-a")
	userB, orgB := insertWorkspace(t, ctx, pool, "n1log-b@example.com", "n1log-b")

	if _, err := pool.Exec(ctx, `
		INSERT INTO public.ai_consume_logs (org_id, user_id, created_at, type, quota, model_name, request_id, other)
		VALUES
			($1, $2, 1700000000, 2, 1625, 'gpt-4o', 'n1log-a', '{"model_ratio":1.25}'::jsonb),
			($3, $4, 1700000001, 2, 1, 'gpt-4o', 'n1log-b', '{}'::jsonb)`,
		orgA, userA, orgB, userB); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.ai_billing_ratio_documents (org_id, kind, document)
		VALUES
			(NULL, 'model_ratio', '{"gpt-4o":1.25}'::jsonb),
			($1, 'model_ratio', '{"gpt-4o":2}'::jsonb)`, orgA); err != nil {
		t.Fatal(err)
	}

	txA := beginApp(t, ctx, pool, orgA)
	var n int
	var quota int64
	if err := txA.QueryRow(ctx, `SELECT count(*), COALESCE(sum(quota), 0) FROM public.ai_consume_logs`).Scan(&n, &quota); err != nil || n != 1 || quota != 1625 {
		t.Fatalf("org A logs n=%d quota=%d err=%v", n, quota, err)
	}
	if err := txA.QueryRow(ctx, `SELECT count(*) FROM public.ai_billing_ratio_documents`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("org A ratio docs n=%d err=%v", n, err)
	}
	rollback(txA)

	// A failed statement aborts the transaction. Each denial gets its own.
	cross := beginApp(t, ctx, pool, orgA)
	if _, err := cross.Exec(ctx, `
		INSERT INTO public.ai_consume_logs (org_id, user_id, created_at, type, quota)
		VALUES ($1, $2, 1700000002, 2, 1)`, orgB, userB); err == nil {
		t.Fatal("org A inserted org B's log")
	}
	rollback(cross)

	platform := beginApp(t, ctx, pool, orgA)
	if _, err := platform.Exec(ctx, `
		INSERT INTO public.ai_billing_ratio_documents (org_id, kind, document)
		VALUES (NULL, 'group_ratio', '{}'::jsonb)`); err == nil {
		t.Fatal("podhub_app inserted a platform ratio row")
	}
	rollback(platform)

	upd := beginApp(t, ctx, pool, orgA)
	if _, err := upd.Exec(ctx, `UPDATE public.ai_consume_logs SET quota = 0`); err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("update: %v", err)
	}
	rollback(upd)

	del := beginApp(t, ctx, pool, orgA)
	if _, err := del.Exec(ctx, `DELETE FROM public.ai_consume_logs`); err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("delete: %v", err)
	}
	rollback(del)

	bare := beginRole(t, ctx, pool, tenant.RoleApp)
	if err := bare.QueryRow(ctx, `SELECT count(*) FROM public.ai_consume_logs`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("missing GUC sees %d %v", n, err)
	}
	if err := bare.QueryRow(ctx, `SELECT count(*) FROM public.ai_billing_ratio_documents`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("missing GUC ratio docs %d %v", n, err)
	}
	rollback(bare)

	noguc := beginRole(t, ctx, pool, tenant.RoleApp)
	if _, err := noguc.Exec(ctx, `
		INSERT INTO public.ai_consume_logs (org_id, user_id, created_at, type, quota)
		VALUES ($1, $2, 1700000003, 2, 1)`, orgA, userA); err == nil {
		t.Fatal("missing GUC inserted a log")
	}
	rollback(noguc)

	worker := beginRole(t, ctx, pool, tenant.RoleWorker)
	err := worker.QueryRow(ctx, `SELECT count(*) FROM public.ai_consume_logs`).Scan(&n)
	if err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("worker select: n=%d err=%v", n, err)
	}
	rollback(worker)
}

func rollback(tx pgx.Tx) {
	_ = tx.Rollback(context.Background())
}

func beginApp(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID int64) pgx.Tx {
	t.Helper()
	tx, err := tenant.BeginApp(ctx, pool.Begin, orgID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	return tx
}

func beginRole(t *testing.T, ctx context.Context, pool *pgxpool.Pool, role string) pgx.Tx {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	if _, err := tx.Exec(ctx, `SELECT set_config('role', $1, true)`, role); err != nil {
		t.Fatal(err)
	}
	return tx
}
