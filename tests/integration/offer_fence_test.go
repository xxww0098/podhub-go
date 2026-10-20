package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestSubmissionOfferFence locks guard_submission_offer as migration 00260
// left it. A queued NULL offer is busy even on an empty store. A NULL offer
// already stored as unknown fences every concrete offer on that store.
func TestSubmissionOfferFence(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	_, org := insertWorkspace(t, ctx, pool, "fence-"+uuid.NewString()+"@example.com", "Fence")
	_, store := insertNextStore(t, ctx, pool, org)

	nullRow := insertFenceRow(t, ctx, pool, org, store)
	insertIntent(t, ctx, pool, uuid.NewString(), org, store, nullRow, "unknown", "op-null-unknown", nil, nil)

	concreteRow := insertFenceRow(t, ctx, pool, org, store)
	err := insertIntentResult(ctx, pool, uuid.NewString(), org, store, concreteRow, "queued", "op-concrete", nil, strPtr("SKU-1"))
	assertOfferBusy(t, err)

	_, other := insertNextStore(t, ctx, pool, org)
	rowA := insertFenceRow(t, ctx, pool, org, other)
	rowB := insertFenceRow(t, ctx, pool, org, other)
	if err := insertIntentResult(ctx, pool, uuid.NewString(), org, other, rowA, "queued", "op-a", nil, strPtr("SKU-A")); err != nil {
		t.Fatal(err)
	}
	if err := insertIntentResult(ctx, pool, uuid.NewString(), org, other, rowB, "queued", "op-b", nil, strPtr("SKU-B")); err != nil {
		t.Fatal(err)
	}
	rowC := insertFenceRow(t, ctx, pool, org, other)
	err = insertIntentResult(ctx, pool, uuid.NewString(), org, other, rowC, "queued", "op-a2", nil, strPtr("SKU-A"))
	assertOfferBusy(t, err)

	_, replayStore := insertNextStore(t, ctx, pool, org)
	replayRow := insertFenceRow(t, ctx, pool, org, replayStore)
	if err := insertIntentResult(ctx, pool, uuid.NewString(), org, replayStore, replayRow, "queued", "op-same", nil, strPtr("SKU-R")); err != nil {
		t.Fatal(err)
	}
	replayRow2 := insertFenceRow(t, ctx, pool, org, replayStore)
	err = insertIntentResult(ctx, pool, uuid.NewString(), org, replayStore, replayRow2, "queued", "op-same", nil, strPtr("SKU-R2"))
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" || pgErr.ConstraintName != "submission_intents_client_op" {
		t.Fatalf("client op replay: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.submission_intents WHERE store_id = $1::uuid AND client_operation_id = 'op-same'`, replayStore).Scan(&n); err != nil || n != 1 {
		t.Fatalf("replay rows %d %v", n, err)
	}

	_, empty := insertNextStore(t, ctx, pool, org)
	emptyRow := insertFenceRow(t, ctx, pool, org, empty)
	err = insertIntentResult(ctx, pool, uuid.NewString(), org, empty, emptyRow, "queued", "op-blank", nil, nil)
	assertOfferBusy(t, err)

	bare, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer bare.Release()
	tx, err := bare.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	var seen int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM submission_intents`).Scan(&seen); err != nil || seen != 0 {
		t.Fatalf("missing GUC sees %d %v", seen, err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO submission_intents (id, org_id, store_id, listing_row_id, row_revision, client_operation_id, request_hash, state) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 4, 'missing-guc', 'h', 'queued')`, uuid.NewString(), org, store, concreteRow); err == nil {
		t.Fatal("missing GUC inserted an intent")
	}
}

func insertNextStore(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64) (int64, string) {
	t.Helper()
	id := uuid.NewString()
	var order, pk int64
	if err := pool.QueryRow(ctx, `SELECT COALESCE(MAX(create_order), 0) + 1 FROM public.organization_stores WHERE org_id = $1`, org).Scan(&order); err != nil {
		t.Fatal(err)
	}
	err := pool.QueryRow(ctx, `
		INSERT INTO public.organization_stores (org_id, uuid, create_order, name)
		VALUES ($1, $2::uuid, $3, 'grant') RETURNING id`, org, id, order).Scan(&pk)
	if err != nil {
		t.Fatal(err)
	}
	return pk, id
}

func insertFenceRow(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, store string) string {
	t.Helper()
	id := uuid.NewString()
	_, err := pool.Exec(ctx, `
		INSERT INTO public.listing_rows (id, org_id, card_id, revision, store_id)
		VALUES ($1::uuid, $2, $3::uuid, 1, $4::uuid)`, id, org, uuid.NewString(), store)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func insertIntentResult(ctx context.Context, pool *pgxpool.Pool, id string, org int64, store, row, state, op string, last, offer *string) error {
	_, err := pool.Exec(ctx, `
		INSERT INTO public.submission_intents (
			id, org_id, store_id, listing_row_id, row_revision, client_operation_id, request_hash, state, last_error_code, offer_id
		) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 4, $5, 'hash', $6, $7, $8)`,
		id, org, store, row, op, state, last, offer)
	return err
}

func assertOfferBusy(t *testing.T, err error) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" || pgErr.ConstraintName != "submission_intents_offer_busy" {
		t.Fatalf("offer busy: %v", err)
	}
}
