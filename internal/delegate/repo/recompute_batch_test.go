package delegaterepo

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestRecomputeBatchParity(t *testing.T) {
	pool, ctx := parityDB(t)
	user := int64(884001)
	org := seedOrg(t, ctx, pool, user, "recompute-batch")
	sourceA := "src-recompute-ef78-a"
	sourceB := "src-recompute-ef78-b"
	seedSource(t, ctx, pool, sourceA, "A")
	seedSource(t, ctx, pool, sourceB, "B")
	t.Cleanup(func() {
		cleanupDelegate(t, context.Background(), pool, org, user, sourceA)
		cleanupDelegate(t, context.Background(), pool, 0, 0, sourceB)
	})

	store := "88400100-0000-4000-8000-000000000001"
	const nowMS = int64(9000)
	seedRecomputeFixture(t, ctx, pool, org, user, store, sourceA, sourceB)

	oracleTx := beginDelegate(t, ctx, pool, org)
	if err := recomputeStoreSequential(ctx, oracleTx, org, store, true, nowMS); err != nil {
		oracleTx.Rollback(ctx)
		t.Fatal(err)
	}
	wantOrders := readOrders(t, ctx, oracleTx, org, store)
	wantPackets := readPackets(t, ctx, oracleTx, org)
	wantAssets := readAssetLinks(t, ctx, oracleTx, org)
	oracleTx.Rollback(ctx)

	gotTx := beginDelegate(t, ctx, pool, org)
	if err := recomputeStore(ctx, gotTx, org, store, true, nowMS); err != nil {
		gotTx.Rollback(ctx)
		t.Fatal(err)
	}
	gotOrders := readOrders(t, ctx, gotTx, org, store)
	gotPackets := readPackets(t, ctx, gotTx, org)
	gotAssets := readAssetLinks(t, ctx, gotTx, org)
	gotTx.Rollback(ctx)

	if fmt.Sprint(gotOrders) != fmt.Sprint(wantOrders) {
		t.Fatalf("orders\n got %v\nwant %v", gotOrders, wantOrders)
	}
	if fmt.Sprint(gotPackets) != fmt.Sprint(wantPackets) {
		t.Fatalf("packets\n got %v\nwant %v", gotPackets, wantPackets)
	}
	if fmt.Sprint(gotAssets) != fmt.Sprint(wantAssets) {
		t.Fatalf("assets\n got %v\nwant %v", gotAssets, wantAssets)
	}

	countStore := "88400100-0000-4000-8000-000000000002"
	for i := 0; i < 50; i++ {
		var orderID string
		if err := pool.QueryRow(ctx, `
			INSERT INTO delegate_orders (org_id, store_id, posting_number, state, created_at_ms, updated_at_ms)
			VALUES ($1, $2::uuid, $3, 'awaiting_setup', 1, 1) RETURNING order_id::text`,
			org, countStore, fmt.Sprintf("count-%02d", i)).Scan(&orderID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO delegate_order_lines (org_id, order_id, offer_id, quantity)
			VALUES ($1, $2::uuid, $3, 1)`, org, orderID, fmt.Sprintf("offer-count-%02d", i)); err != nil {
			t.Fatal(err)
		}
	}
	traced, trace := delegateTracedPool(t, ctx, pool)
	trace.reset()
	tx := beginDelegate(t, ctx, traced, org)
	if err := recomputeStore(ctx, tx, org, countStore, false, nowMS); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	tx.Rollback(ctx)
	selects := trace.count("l.order_id = ANY")
	updates := trace.count("UPDATE delegate_orders SET state")
	t.Logf("50 unfinished orders: line select %d, state update %d", selects, updates)
	if selects != 1 || updates != 50 {
		t.Fatalf("statements select=%d update=%d", selects, updates)
	}

	emptyStore := "88400100-0000-4000-8000-000000000003"
	trace.reset()
	tx = beginDelegate(t, ctx, traced, org)
	if err := recomputeStore(ctx, tx, org, emptyStore, false, nowMS); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	tx.Rollback(ctx)
	if n := trace.count("l.order_id = ANY"); n != 0 {
		t.Fatalf("empty store queried lines %d", n)
	}
}

func TestDispatchAssetBatchParity(t *testing.T) {
	pool, ctx := parityDB(t)
	user := int64(884002)
	org := seedOrg(t, ctx, pool, user, "asset-batch")
	source := "src-asset-ef78"
	seedSource(t, ctx, pool, source, "A")
	t.Cleanup(func() { cleanupDelegate(t, context.Background(), pool, org, user, source) })
	store := uuid.NewString()
	var orderID, dispatchID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO delegate_orders (org_id, store_id, posting_number, state, logistics, created_at_ms, updated_at_ms)
		VALUES ($1, $2::uuid, $3, 'ready', '{"t":1}'::jsonb, 1, 1) RETURNING order_id::text`,
		org, store, "asset-"+uuid.NewString()).Scan(&orderID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO delegate_dispatches (org_id, order_id, source_id, dispatch_no, payload, state, created_at_ms, updated_at_ms)
		VALUES ($1, $2::uuid, $3, $4, '{}'::jsonb, 'dispatched', 1, 1) RETURNING dispatch_id::text`,
		org, orderID, source, "no-"+uuid.NewString()).Scan(&dispatchID); err != nil {
		t.Fatal(err)
	}
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()}
	if _, err := pool.Exec(ctx, `
		INSERT INTO delegate_dispatch_assets (dispatch_id, asset_id, org_id)
		VALUES ($1::uuid, $2::uuid, $3)`, dispatchID, ids[0], org); err != nil {
		t.Fatal(err)
	}

	oracleTx := beginDelegate(t, ctx, pool, org)
	if err := insertAssetsSequential(ctx, oracleTx, dispatchID, ids, org); err != nil {
		oracleTx.Rollback(ctx)
		t.Fatal(err)
	}
	want := readDispatchAssets(t, ctx, oracleTx, dispatchID)
	oracleTx.Rollback(ctx)

	traced, trace := delegateTracedPool(t, ctx, pool)
	trace.reset()
	gotTx := beginDelegate(t, ctx, traced, org)
	if err := insertDispatchAssets(ctx, gotTx, dispatchID, ids, org); err != nil {
		gotTx.Rollback(ctx)
		t.Fatal(err)
	}
	got := readDispatchAssets(t, ctx, gotTx, dispatchID)
	if err := gotTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("assets\n got %v\nwant %v", got, want)
	}
	n := trace.count("INSERT INTO delegate_dispatch_assets")
	t.Logf("dispatch asset insert statements for %d assets: %d", len(ids), n)
	if n != 1 {
		t.Fatalf("statements %d", n)
	}

	trace.reset()
	emptyTx := beginDelegate(t, ctx, traced, org)
	if err := insertDispatchAssets(ctx, emptyTx, dispatchID, nil, org); err != nil {
		emptyTx.Rollback(ctx)
		t.Fatal(err)
	}
	emptyTx.Rollback(ctx)
	if n := trace.count("delegate_dispatch_assets"); n != 0 {
		t.Fatalf("empty asset list queried %d", n)
	}
}

func BenchmarkRecomputeOrders(b *testing.B) {
	pool, ctx := parityDB(b)
	user := int64(884003)
	org := seedOrg(b, ctx, pool, user, "recompute-bench")
	b.Cleanup(func() { cleanupDelegate(b, context.Background(), pool, org, user, "") })
	store := "88400300-0000-4000-8000-000000000001"
	for i := 0; i < 50; i++ {
		if _, err := pool.Exec(ctx, `
			INSERT INTO delegate_orders (org_id, store_id, posting_number, state, created_at_ms, updated_at_ms)
			VALUES ($1, $2::uuid, $3, 'awaiting_setup', 1, 1)`, org, store, fmt.Sprintf("bench-%02d", i)); err != nil {
			b.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO delegate_order_lines (org_id, order_id, offer_id, quantity)
		SELECT $1, order_id, 'offer-' || order_id::text, 1
		  FROM delegate_orders WHERE org_id = $1 AND store_id = $2::uuid`, org, store); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		tx := beginDelegate(b, ctx, pool, org)
		if err := recomputeStore(ctx, tx, org, store, false, int64(1000+i)); err != nil {
			tx.Rollback(ctx)
			b.Fatal(err)
		}
		tx.Rollback(ctx)
	}
}

func recomputeStoreSequential(ctx context.Context, tx pgx.Tx, orgID int64, storeID string, auto bool, nowMS int64) error {
	rows, err := tx.Query(ctx, `
		SELECT order_id::text FROM delegate_orders
		 WHERE org_id = $1 AND store_id = $2::uuid AND state IN (`+openStates+`)
		 ORDER BY order_id
		   FOR UPDATE`, orgID, storeID)
	if err != nil {
		return err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	for _, id := range ids {
		if err := recompute(ctx, tx, id, nowMS); err != nil {
			return err
		}
		if auto {
			if err := dispatchReady(ctx, tx, orgID, id, nowMS); err != nil {
				return err
			}
		}
	}
	return nil
}

func insertAssetsSequential(ctx context.Context, tx pgx.Tx, dispatchID string, assetIDs []string, orgID int64) error {
	for _, assetID := range assetIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO delegate_dispatch_assets (dispatch_id, asset_id, org_id)
			VALUES ($1::uuid, $2::uuid, $3)
			ON CONFLICT (dispatch_id, asset_id) DO NOTHING`, dispatchID, assetID, orgID); err != nil {
			return err
		}
	}
	return nil
}

func seedRecomputeFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, user int64, store, sourceA, sourceB string) {
	t.Helper()
	bind := func(offer string, active bool) string {
		t.Helper()
		var id string
		if err := pool.QueryRow(ctx, `
			INSERT INTO delegate_bindings (org_id, store_id, offer_id, source_id, active, created_by, created_at_ms, updated_at_ms)
			VALUES ($1, $2::uuid, $3, $4, $5, $6, 1, 1) RETURNING binding_id::text`,
			org, store, offer, sourceA, active, user).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	addAsset := func(binding string) string {
		t.Helper()
		var id string
		if err := pool.QueryRow(ctx, `
			INSERT INTO delegate_assets (org_id, binding_id, object_key, sha256, bytes, mime, file_name, verified_at_ms, created_at_ms)
			VALUES ($1, $2::uuid, $3, $4, 10, 'image/png', 'a.png', 1, 1) RETURNING asset_id::text`,
			org, binding, "key-"+uuid.NewString(), "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef").Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	addOrder := func(posting, state, logistics string) string {
		t.Helper()
		var id string
		if err := pool.QueryRow(ctx, `
			INSERT INTO delegate_orders (org_id, store_id, posting_number, state, logistics, created_at_ms, updated_at_ms)
			VALUES ($1, $2::uuid, $3, $4, NULLIF($5, '')::jsonb, 1, 1) RETURNING order_id::text`,
			org, store, posting, state, logistics).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	addLine := func(orderID, offer, binding string) string {
		t.Helper()
		var bindingArg any
		if binding != "" {
			bindingArg = binding
		}
		var id string
		if err := pool.QueryRow(ctx, `
			INSERT INTO delegate_order_lines (org_id, order_id, offer_id, quantity, binding_id)
			VALUES ($1, $2::uuid, $3, 1, $4::uuid) RETURNING line_id::text`,
			org, orderID, offer, bindingArg).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}

	shared := bind("offer-shared", true)
	addAsset(shared)
	addAsset(shared)
	orderA := addOrder("post-a", "awaiting_setup", `{"carrier":"c"}`)
	addLine(orderA, "line-a1", shared)
	addLine(orderA, "line-a2", shared)
	other := bind("offer-b", true)
	if _, err := pool.Exec(ctx, `UPDATE delegate_bindings SET source_id = $2 WHERE binding_id = $1::uuid`, other, sourceB); err != nil {
		t.Fatal(err)
	}
	addAsset(other)
	addLine(orderA, "line-a3", other)

	orderB := addOrder("post-b", "awaiting_setup", `{"carrier":"c"}`)
	addLine(orderB, "line-b", "")

	orderC := addOrder("post-c", "awaiting_setup", `{"carrier":"c"}`)
	ready := bind("offer-c", true)
	addAsset(ready)
	lineC := addLine(orderC, "line-c", ready)
	if _, err := pool.Exec(ctx, `
		INSERT INTO delegate_dispatches (org_id, order_id, source_id, dispatch_no, payload, state, created_at_ms, updated_at_ms)
		VALUES ($1, $2::uuid, $3, $4, jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('line_id', 'not-this-line'))), 'dispatched', 1, 1)`,
		org, orderC, sourceA, "no-existing-"+uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	_ = lineC

	addOrder("post-d", "awaiting_setup", "")
	addOrder("post-done", "done", `{"carrier":"c"}`)
}

type orderSnap struct {
	ID, State string
	Updated   int64
}

type packetSnap struct {
	OrderID, Source, State, Payload, Attempted string
	Org, Created, Updated                      int64
}

type assetSnap struct {
	OrderID, Source, Asset string
	Org                    int64
}

type dispatchAssetSnap struct {
	DispatchID, AssetID string
	Org                 int64
}

type rowQuery interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func readOrders(t *testing.T, ctx context.Context, q rowQuery, org int64, store string) []orderSnap {
	t.Helper()
	rows, err := q.Query(ctx, `
		SELECT order_id::text, state, updated_at_ms
		  FROM delegate_orders WHERE org_id = $1 AND store_id = $2::uuid
		 ORDER BY posting_number`, org, store)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []orderSnap
	for rows.Next() {
		var row orderSnap
		if err := rows.Scan(&row.ID, &row.State, &row.Updated); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func readPackets(t *testing.T, ctx context.Context, q rowQuery, org int64) []packetSnap {
	t.Helper()
	rows, err := q.Query(ctx, `
		SELECT order_id::text, source_id, state, payload::text, attempted_by, org_id, created_at_ms, updated_at_ms
		  FROM delegate_dispatches WHERE org_id = $1
		 ORDER BY order_id::text, source_id, state, created_at_ms`, org)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []packetSnap
	for rows.Next() {
		var row packetSnap
		if err := rows.Scan(&row.OrderID, &row.Source, &row.State, &row.Payload, &row.Attempted, &row.Org, &row.Created, &row.Updated); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func readAssetLinks(t *testing.T, ctx context.Context, q rowQuery, org int64) []assetSnap {
	t.Helper()
	rows, err := q.Query(ctx, `
		SELECT d.order_id::text, d.source_id, a.asset_id::text, a.org_id
		  FROM delegate_dispatch_assets a
		  JOIN delegate_dispatches d ON d.dispatch_id = a.dispatch_id
		 WHERE d.org_id = $1
		 ORDER BY 1, 2, 3`, org)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []assetSnap
	for rows.Next() {
		var row assetSnap
		if err := rows.Scan(&row.OrderID, &row.Source, &row.Asset, &row.Org); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func readDispatchAssets(t *testing.T, ctx context.Context, q rowQuery, dispatchID string) []dispatchAssetSnap {
	t.Helper()
	rows, err := q.Query(ctx, `
		SELECT dispatch_id::text, asset_id::text, org_id
		  FROM delegate_dispatch_assets WHERE dispatch_id = $1::uuid
		 ORDER BY asset_id::text`, dispatchID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []dispatchAssetSnap
	for rows.Next() {
		var row dispatchAssetSnap
		if err := rows.Scan(&row.DispatchID, &row.AssetID, &row.Org); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func beginDelegate(t testing.TB, ctx context.Context, pool *pgxpool.Pool, org int64) pgx.Tx {
	t.Helper()
	tx, err := tenantx.BeginApp(ctx, pool.Begin, org)
	if err != nil {
		t.Fatal(err)
	}
	return tx
}

type delegateTrace struct {
	mu   sync.Mutex
	sqls []string
}

func (s *delegateTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	s.mu.Lock()
	s.sqls = append(s.sqls, data.SQL)
	s.mu.Unlock()
	return ctx
}

func (s *delegateTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (s *delegateTrace) reset() {
	s.mu.Lock()
	s.sqls = nil
	s.mu.Unlock()
}

func (s *delegateTrace) count(part string) int {
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

func delegateTracedPool(t testing.TB, ctx context.Context, base *pgxpool.Pool) (*pgxpool.Pool, *delegateTrace) {
	t.Helper()
	cfg := base.Config().Copy()
	tr := &delegateTrace{}
	cfg.ConnConfig.Tracer = tr
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, tr
}
