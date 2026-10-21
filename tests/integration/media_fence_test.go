package integration

import (
	"context"
	"errors"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/media/domain/fence"
	"github.com/xxww0098/podhub-go/internal/media/jobs/slicepurge"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

const (
	mediaUserA = int64(92041)
	mediaUserB = int64(92042)
	workspaceA = "550e8400-e29b-41d4-a716-446655440000"
	workspaceB = "550e8400-e29b-41d4-a716-446655440001"
	imageHash  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	probeHash  = "aa7bb0431aaeb198a77c26a14fe6dd714a75e4d7db94e3e1238a1fdcbfe1f8d4"
)

func TestMediaFenceAndIsolation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	t.Run("sql extractors", func(t *testing.T) { testSQLExtractors(t, ctx, pool) })
	t.Run("retired upload is P0M01", func(t *testing.T) { testRetiredUpload(t, ctx, pool) })
	t.Run("media blob rls", func(t *testing.T) { testMediaBlobRLS(t, ctx, pool) })
	t.Run("cleanup receipt", func(t *testing.T) { testCleanupReceipt(t, ctx, pool) })
}

func testSQLExtractors(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	other := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	samples := []string{
		"images/teams/" + workspaceA + "/sha256/" + imageHash + ".jpg",
		"IMAGES/TEAMS/" + strings.ToUpper(workspaceA) + "/SHA256/" + strings.ToUpper(imageHash) + ".JPG",
		"videos/teams/" + workspaceA + "/sha256/" + imageHash + ".mp4",
		"images/teams/" + workspaceA + "/sha256/" + probeHash + ".png",
		"images/./teams/" + workspaceA + "/sha256/" + imageHash + ".jpg",
		"see teams/" + workspaceA + "/sha256/" + imageHash + ".jpg and workspaces/" + workspaceB + "/sha256/" + other + ".png?x=1",
		"ordinary text",
	}
	for _, sample := range samples {
		var isKey bool
		var identity string
		if err := pool.QueryRow(ctx, `
			SELECT public.is_media_gc_image_key($1), COALESCE(public.media_gc_image_identity($1), '')`, sample).Scan(&isKey, &identity); err != nil {
			t.Fatal(err)
		}
		if isKey != fence.IsGCImageKey(sample) || identity != fence.ImageIdentity(sample) {
			t.Fatalf("extractor drift %q sql %v %q go %v %q", sample, isKey, identity, fence.IsGCImageKey(sample), fence.ImageIdentity(sample))
		}
		rows, err := pool.Query(ctx, `
			SELECT workspace_uuid::text, content_hash
			FROM public.media_reference_candidates($1)
			ORDER BY 1, 2`, sample)
		if err != nil {
			t.Fatal(err)
		}
		var sqlCandidates []fence.Candidate
		for rows.Next() {
			var item fence.Candidate
			if err := rows.Scan(&item.Workspace, &item.Digest); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			sqlCandidates = append(sqlCandidates, item)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		goCandidates := fence.Candidates(sample)
		sort.Slice(goCandidates, func(i, j int) bool {
			if goCandidates[i].Workspace == goCandidates[j].Workspace {
				return goCandidates[i].Digest < goCandidates[j].Digest
			}
			return goCandidates[i].Workspace < goCandidates[j].Workspace
		})
		if len(sqlCandidates) != len(goCandidates) {
			t.Fatalf("candidates %q sql %+v go %+v", sample, sqlCandidates, goCandidates)
		}
		for i := range sqlCandidates {
			if sqlCandidates[i] != goCandidates[i] {
				t.Fatalf("candidates %q sql %+v go %+v", sample, sqlCandidates, goCandidates)
			}
		}
	}
}

func testRetiredUpload(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	orgID := insertMediaOrg(t, ctx, pool, mediaUserA, "media-a@example.invalid", "Media A", workspaceA)
	key := "images/teams/" + workspaceA + "/sha256/" + imageHash + ".jpg"
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.media_object_leases (
			workspace_uuid, batch_id, content_hash, org_id, object_key, media_account_id,
			first_seen_at, last_hit_at, expires_at, retired_at)
		VALUES ($1::uuid, '', $2, $3, $4, 'acct', clock_timestamp(), clock_timestamp(), clock_timestamp(), clock_timestamp())
		ON CONFLICT (workspace_uuid, batch_id, content_hash) DO NOTHING`, workspaceA, imageHash, orgID, key); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO public.media_uploads (
			id, org_id, idempotency_key, expected_sha256, expected_size, expected_mime,
			storage_key, state, expires_at)
		VALUES (gen_random_uuid(), $1, 'retired-upload', $2, 12, 'image/jpeg', $3, 'pending', clock_timestamp() + interval '1 hour')`,
		orgID, imageHash, key)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "P0M01" {
		t.Fatalf("pending upload of a retired key must raise P0M01, got %v", err)
	}
	live := "images/teams/" + workspaceA + "/sha256/" + strings.Repeat("c", 64) + ".jpg"
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.media_uploads (
			id, org_id, idempotency_key, expected_sha256, expected_size, expected_mime,
			storage_key, state, expires_at)
		VALUES (gen_random_uuid(), $1, 'live-upload', $2, 12, 'image/jpeg', $3, 'pending', clock_timestamp() + interval '1 hour')`,
		orgID, strings.Repeat("c", 64), live); err != nil {
		t.Fatal(err)
	}
}

func testMediaBlobRLS(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	orgA := insertMediaOrg(t, ctx, pool, mediaUserA, "media-a@example.invalid", "Media A", workspaceA)
	orgB := insertMediaOrg(t, ctx, pool, mediaUserB, "media-b@example.invalid", "Media B", workspaceB)
	hash := strings.Repeat("d", 64)
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.media_blobs (id, org_id, sha256, size_bytes, mime, storage_key, state)
		VALUES (gen_random_uuid(), $1, $2, 4, 'image/jpeg', 'plain/blob', 'verified')
		ON CONFLICT (org_id, sha256) DO NOTHING`, orgA, hash); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tenant.EnterApp(ctx, tx, orgB); err != nil {
		t.Fatal(err)
	}
	var seen int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM public.media_blobs WHERE sha256 = $1`, hash).Scan(&seen); err != nil {
		t.Fatal(err)
	}
	if seen != 0 {
		t.Fatalf("org B saw %d blobs belonging to org A", seen)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tenant.EnterApp(ctx, tx, orgA); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM public.media_blobs WHERE sha256 = $1`, hash).Scan(&seen); err != nil {
		t.Fatal(err)
	}
	if seen != 1 {
		t.Fatalf("org A saw %d of its own blobs", seen)
	}
}

func testCleanupReceipt(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	fingerprint := slicepurge.FakeFingerprint("podhub-transit")
	// 2026-10-15T20:00Z is 2026-10-16 04:00 Asia/Shanghai. LastClearBoundary is
	// the previous gate, so now.After(LastClearBoundary) is true all night and
	// does not describe this claim. The SQL claims the Shanghai calendar date
	// only at or after that date's 04:00, including the instant itself.
	before := time.Date(2026, 10, 15, 19, 59, 59, 999_000_000, time.UTC)
	boundary := time.Date(2026, 10, 15, 20, 0, 0, 0, time.UTC)
	night := time.Date(2026, 10, 16, 18, 0, 0, 0, time.UTC) // 2026-10-17 02:00 Shanghai
	claim, err := slicepurge.TryClaimAt(ctx, pool, fingerprint, before)
	if err != nil {
		t.Fatal(err)
	}
	if claim != nil {
		t.Fatal("before that Shanghai date's 04:00 the claim SQL must not take a receipt")
	}
	claim, err = slicepurge.TryClaimAt(ctx, pool, fingerprint, boundary)
	if err != nil {
		t.Fatal(err)
	}
	if claim == nil {
		t.Fatal("at 04:00 Shanghai the claim SQL must take a receipt")
	}
	claim, err = slicepurge.TryClaimAt(ctx, pool, fingerprint, night)
	if err != nil {
		t.Fatal(err)
	}
	if claim != nil {
		t.Fatal("after midnight and before the next 04:00 the claim SQL must not take a receipt")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tenant.EnterApp(ctx, tx, 1); err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `DELETE FROM public.transit_clear_runs WHERE bucket_identity = $1`, fingerprint)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Fatalf("podhub_app must not delete cleanup receipts, got %v", err)
	}
}

func insertMediaOrg(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64, email, name, workspace string) int64 {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'user', $4, '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())
		ON CONFLICT (id) DO NOTHING`, userID, email, email, name); err != nil {
		t.Fatal(err)
	}
	var orgID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM organizations WHERE owner_user_id = $1`, userID).Scan(&orgID); err != nil {
		if _, err := pool.Exec(ctx, `
			INSERT INTO organizations (owner_user_id, name, plan, uuid, created_at, updated_at)
			VALUES ($1, $2, 'lite', $3::uuid, clock_timestamp(), clock_timestamp())`, userID, name, workspace); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT id FROM organizations WHERE owner_user_id = $1`, userID).Scan(&orgID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE organizations SET uuid = $2::uuid WHERE id = $1`, orgID, workspace); err != nil {
		t.Fatal(err)
	}
	return orgID
}
