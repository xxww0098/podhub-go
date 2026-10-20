package shippingrepo

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

func TestBindSKUsBatchParity(t *testing.T) {
	pool, ctx := shipParityDB(t)
	shipSeedLease(t, ctx, pool)
	user := int64(885001)
	org := seedShippingOrg(t, ctx, pool, user)
	presetA := "preset-ef78-a"
	presetB := "preset-ef78-b"
	insertPreset(t, ctx, pool, presetA, "预设甲")
	insertPreset(t, ctx, pool, presetB, "预设乙")
	ids := make([]string, 40)
	for i := range ids {
		ids[i] = fmt.Sprintf("sku-ef78-%02d", i)
		insertShippingSKU(t, ctx, pool, ids[i], fmt.Sprintf("scp-ef78-%02d", i), int64(1000-i))
	}
	actor := domain.Actor{UserID: user, OrgID: org, PublicID: "pub-ef78"}
	t.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `DELETE FROM audit_logs WHERE user_id = $1 AND action = 'shipping_sku_bound'`, user)
		_, _ = pool.Exec(c, `DELETE FROM shipping_sku_bindings WHERE sku_id LIKE 'sku-ef78-%' OR sku_id = 'sku-ef78-apply'`)
		_, _ = pool.Exec(c, `DELETE FROM sc_skus WHERE sku_id LIKE 'sku-ef78-%' OR sku_id = 'sku-ef78-apply'`)
		_, _ = pool.Exec(c, `DELETE FROM sc_products WHERE product_id LIKE 'scp-ef78-%' OR product_id = 'scp-ef78-apply' OR product_id = 'scp-ef78-empty'`)
		_, _ = pool.Exec(c, `DELETE FROM shipping_preset_versions WHERE preset_id LIKE 'preset-ef78-%'`)
		_, _ = pool.Exec(c, `DELETE FROM shipping_presets WHERE preset_id LIKE 'preset-ef78-%'`)
		_, _ = pool.Exec(c, `DELETE FROM organization_members WHERE org_id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM organizations WHERE id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM account_users WHERE id = $1`, user)
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO shipping_sku_bindings (sku_id, preset_id, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ($1, $2, 10, 10, 'old')`, ids[0], presetA); err != nil {
		t.Fatal(err)
	}

	shuffled := append([]string(nil), ids...)
	for i, j := 0, len(shuffled)-1; i < j; i, j = i+1, j-1 {
		shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
	}
	const now = int64(5000)
	oracleTx, err := corerepo.BeginAdmin(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	wantRows, err := bindSKUsSequential(ctx, oracleTx, actor, shuffled, presetB, now)
	if err != nil {
		oracleTx.Rollback(ctx)
		t.Fatal(err)
	}
	wantCols := readBindings(t, ctx, oracleTx, shuffled)
	wantAudit := readBindingAudit(t, ctx, oracleTx, user)
	oracleTx.Rollback(ctx)

	repo := ShippingRepo{Pool: pool}
	var gotRows []domain.Binding
	err = repo.write(ctx, func(tx pgx.Tx) error {
		var err error
		gotRows, err = bindSKUs(ctx, tx, actor, shuffled, presetB, now)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(bindingOrder(gotRows), ",") != strings.Join(bindingOrder(wantRows), ",") {
		t.Fatalf("return order\n got %v\nwant %v", bindingOrder(gotRows), bindingOrder(wantRows))
	}
	gotCols := readBindings(t, ctx, pool, shuffled)
	if fmt.Sprint(gotCols) != fmt.Sprint(wantCols) {
		t.Fatalf("bindings\n got %v\nwant %v", gotCols, wantCols)
	}
	gotAudit := readBindingAudit(t, ctx, pool, user)
	if fmt.Sprint(gotAudit) != fmt.Sprint(wantAudit) {
		t.Fatalf("audit\n got %v\nwant %v", gotAudit, wantAudit)
	}
	if gotCols[indexSKU(gotCols, ids[0])].Created != 10 || gotCols[indexSKU(gotCols, ids[0])].Updated != now {
		t.Fatalf("existing created_at changed %+v", gotCols[indexSKU(gotCols, ids[0])])
	}

	before := readBindings(t, ctx, pool, shuffled)
	err = repo.write(ctx, func(tx pgx.Tx) error {
		_, err := bindSKUs(ctx, tx, actor, []string{ids[3], "sku-ef78-missing"}, presetA, 99)
		return err
	})
	var api *domain.APIError
	if !errors.As(err, &api) || api.Status != 400 || api.Code != "VALIDATION" || api.Message != "平台 SKU 不存在" {
		t.Fatalf("missing sku %v", err)
	}
	after := readBindings(t, ctx, pool, shuffled)
	if fmt.Sprint(after) != fmt.Sprint(before) {
		t.Fatalf("missing sku did not roll back\n got %v\nwant %v", after, before)
	}

	insertShippingSKU(t, ctx, pool, "sku-ef78-apply", "scp-ef78-apply", 1)
	applied, err := repo.Apply(ctx, actor, "scp-ef78-apply", presetB, 77)
	if err != nil || len(applied) != 1 || applied[0].SKUID != "sku-ef78-apply" || applied[0].UpdatedAtMs != 77 {
		t.Fatalf("apply %+v %v", applied, err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_products (product_id, title, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ('scp-ef78-empty', '空', 1, 1, 'pub')`); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Apply(ctx, actor, "scp-ef78-empty", presetB, 1); err == nil || err.Error() != "平台商品没有 SKU" {
		t.Fatalf("empty product %v", err)
	}
	if _, err := repo.Apply(ctx, actor, "scp-ef78-absent", presetB, 1); err == nil || err.Error() != "平台商品不存在" {
		t.Fatalf("absent product %v", err)
	}

	traced, trace := shippingTracedPool(t, ctx, pool)
	tracedRepo := ShippingRepo{Pool: traced}
	trace.reset()
	if err := tracedRepo.write(ctx, func(tx pgx.Tx) error {
		_, err := bindSKUs(ctx, tx, actor, ids, presetB, 6000)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	exist := trace.count("sku_id = ANY")
	upserts := trace.count("INSERT INTO public.shipping_sku_bindings")
	audits := trace.count("INSERT INTO audit_logs")
	t.Logf("40 SKUs: existence %d, upsert %d, audit %d, traced statements %d", exist, upserts, audits, trace.len())
	if exist != 1 || upserts != 1 || audits != 40 {
		t.Fatalf("statements exist=%d upsert=%d audit=%d", exist, upserts, audits)
	}
}

func BenchmarkBindSKUs(b *testing.B) {
	pool, ctx := shipParityDB(b)
	user := int64(885002)
	org := seedShippingOrg(b, ctx, pool, user)
	preset := "preset-ef78-bench"
	clearShippingBench(ctx, pool, user, preset)
	insertPreset(b, ctx, pool, preset, "预设")
	ids := make([]string, 40)
	for i := range ids {
		ids[i] = fmt.Sprintf("sku-ef78-bench-%02d", i)
		insertShippingSKU(b, ctx, pool, ids[i], fmt.Sprintf("scp-ef78-bench-%02d", i), int64(i+1))
	}
	actor := domain.Actor{UserID: user, OrgID: org, PublicID: "pub-bench"}
	repo := ShippingRepo{Pool: pool}
	b.Cleanup(func() {
		c := context.Background()
		clearShippingBench(c, pool, user, preset)
		_, _ = pool.Exec(c, `DELETE FROM organization_members WHERE org_id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM organizations WHERE id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM account_users WHERE id = $1`, user)
	})
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := repo.write(ctx, func(tx pgx.Tx) error {
			_, err := bindSKUs(ctx, tx, actor, ids, preset, int64(8000+i))
			return err
		}); err != nil {
			b.Fatal(err)
		}
	}
}

func bindSKUsSequential(ctx context.Context, tx pgx.Tx, actor domain.Actor, ids []string, preset string, now int64) ([]domain.Binding, error) {
	var out []domain.Binding
	for _, sku := range ids {
		row, err := upsertBinding(ctx, tx, actor, sku, preset, now)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, nil
}

type bindingCol struct {
	SKU, Preset, By  string
	Created, Updated int64
}

type auditCol struct {
	Entity, Action, Method, Path, Message, Status, Result, Module, EntityType string
}

func bindingOrder(rows []domain.Binding) []string {
	out := make([]string, len(rows))
	for i, row := range rows {
		out[i] = row.SKUID
	}
	return out
}

func indexSKU(rows []bindingCol, sku string) int {
	for i, row := range rows {
		if row.SKU == sku {
			return i
		}
	}
	return -1
}

type queryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func readBindings(t testing.TB, ctx context.Context, q queryer, ids []string) []bindingCol {
	t.Helper()
	rows, err := q.Query(ctx, `
		SELECT sku_id, preset_id, created_at_ms, updated_at_ms, created_by_account_uuid
		  FROM shipping_sku_bindings WHERE sku_id = ANY($1::text[])
		 ORDER BY sku_id`, ids)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []bindingCol
	for rows.Next() {
		var row bindingCol
		if err := rows.Scan(&row.SKU, &row.Preset, &row.Created, &row.Updated, &row.By); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func readBindingAudit(t testing.TB, ctx context.Context, q queryer, user int64) []auditCol {
	t.Helper()
	rows, err := q.Query(ctx, `
		SELECT entity_id, action, api_method, api_path, message, status, result, module, entity_type
		  FROM audit_logs
		 WHERE user_id = $1 AND action = 'shipping_sku_bound'
		 ORDER BY id`, user)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []auditCol
	for rows.Next() {
		var row auditCol
		if err := rows.Scan(&row.Entity, &row.Action, &row.Method, &row.Path, &row.Message, &row.Status, &row.Result, &row.Module, &row.EntityType); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func seedShippingOrg(t testing.TB, ctx context.Context, pool *pgxpool.Pool, user int64) int64 {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'super_admin', 't', '/admin', '', 'lite', clock_timestamp(), clock_timestamp())
		ON CONFLICT (id) DO NOTHING`, user, fmt.Sprintf("ship%d", user), fmt.Sprintf("ship%d@example.invalid", user)); err != nil {
		t.Fatal(err)
	}
	var org int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, $2, 'lite', clock_timestamp(), clock_timestamp()) RETURNING id`, user, fmt.Sprintf("ship-org-%d", user)).Scan(&org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1, $2, 'owner', 'active', 't', clock_timestamp(), clock_timestamp(), 1)`, org, user); err != nil {
		t.Fatal(err)
	}
	return org
}

func clearShippingBench(ctx context.Context, pool *pgxpool.Pool, user int64, preset string) {
	_, _ = pool.Exec(ctx, `DELETE FROM audit_logs WHERE user_id = $1 AND action = 'shipping_sku_bound'`, user)
	_, _ = pool.Exec(ctx, `DELETE FROM shipping_sku_bindings WHERE sku_id LIKE 'sku-ef78-bench-%'`)
	_, _ = pool.Exec(ctx, `DELETE FROM sc_skus WHERE sku_id LIKE 'sku-ef78-bench-%'`)
	_, _ = pool.Exec(ctx, `DELETE FROM sc_products WHERE product_id LIKE 'scp-ef78-bench-%'`)
	_, _ = pool.Exec(ctx, `DELETE FROM shipping_preset_versions WHERE preset_id = $1`, preset)
	_, _ = pool.Exec(ctx, `DELETE FROM shipping_presets WHERE preset_id = $1`, preset)
}

func insertPreset(t testing.TB, ctx context.Context, pool *pgxpool.Pool, id, name string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO shipping_presets (preset_id, name, current_version, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ($1, $2, 1, 1, 1, 'pub')`, id, name); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO shipping_preset_versions (preset_id, version, payload, created_at_ms, created_by_account_uuid)
		VALUES ($1, 1, '{}'::jsonb, 1, 'pub')`, id); err != nil {
		t.Fatal(err)
	}
}

func insertShippingSKU(t testing.TB, ctx context.Context, pool *pgxpool.Pool, sku, product string, created int64) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_products (product_id, title, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ($1, '商品', $2, $2, 'pub')`, product, created); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_skus (sku_id, product_id, platform_code, title, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ($1, $2, $3, '规格', $4, $4, 'pub')`, sku, product, "code-"+sku, created); err != nil {
		t.Fatal(err)
	}
}

type shippingTrace struct {
	mu   sync.Mutex
	sqls []string
}

func (s *shippingTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	s.mu.Lock()
	s.sqls = append(s.sqls, data.SQL)
	s.mu.Unlock()
	return ctx
}

func (s *shippingTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (s *shippingTrace) reset() {
	s.mu.Lock()
	s.sqls = nil
	s.mu.Unlock()
}

func (s *shippingTrace) count(part string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, sql := range s.sqls {
		if strings.Contains(sql, part) {
			n++
		}
	}
	return n
}

func (s *shippingTrace) len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sqls)
}

func shipSeedLease(t testing.TB, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, `DELETE FROM writer_lease_events WHERE lease_id IN (
		SELECT id FROM writer_leases WHERE domain = 'admin' AND revoked_at_ms IS NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM writer_leases WHERE domain = 'admin' AND revoked_at_ms IS NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO writer_leases (
		    domain, holder, holder_instance, fence_token, granted_at_ms,
		    expires_at_ms, heartbeat_at_ms, grant_reason)
		VALUES ('admin', 'axum', $1, 1, 0,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint + 600000,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint, 'admin lease')`,
		fmt.Sprintf("axum-%d", os.Getpid())); err != nil {
		t.Fatal(err)
	}
}

var (
	shipOnce sync.Once
	shipPool *pgxpool.Pool
	shipErr  error
)

func shipParityDB(t testing.TB) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("PODHUB_PARITY_DSN")
	if dsn == "" {
		if _, err := os.Stat("/var/run/docker.sock"); err != nil {
			t.Skip("docker daemon is not available")
		}
	}
	shipOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if dsn == "" {
			container, err := postgres.Run(ctx, "postgres:16-alpine",
				postgres.WithDatabase("podhub"),
				postgres.WithUsername("postgres"),
				postgres.WithPassword("postgres"),
				postgres.BasicWaitStrategies(),
			)
			if err != nil {
				shipErr = err
				return
			}
			dsn, err = container.ConnectionString(ctx, "sslmode=disable")
			if err != nil {
				shipErr = err
				return
			}
		}
		cfg := config.Config{DatabaseURL: dsn}
		if err := cfg.CheckDatabase(); err != nil {
			shipErr = err
			return
		}
		_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
		pool, err := db.Connect(ctx, cfg)
		if err != nil {
			shipErr = err
			return
		}
		if err := db.Migrate(ctx, pool); err != nil {
			pool.Close()
			shipErr = err
			return
		}
		shipPool = pool
	})
	if shipErr != nil {
		t.Fatal(shipErr)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	return shipPool, ctx
}

func shippingTracedPool(t testing.TB, ctx context.Context, base *pgxpool.Pool) (*pgxpool.Pool, *shippingTrace) {
	t.Helper()
	cfg := base.Config().Copy()
	tr := &shippingTrace{}
	cfg.ConnConfig.Tracer = tr
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, tr
}
