package integration

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	dbschema "github.com/xxww0098/podhub-go/db"
	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/jobs/slicepurge"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestWorkspaceSliceCleanupPolicyMigration(t *testing.T) {
	if !testkit.DockerAvailable() {
		t.Skip("docker daemon is not available")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	dsn, stop, err := testkit.StartPostgres(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	goose.SetBaseFS(dbschema.Migrations)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	if err := goose.UpToContext(ctx, sqlDB, "migrations", 35); err != nil {
		t.Fatal(err)
	}
	_ = sqlDB.Close()
	owner, org, _ := securityOrg(t, ctx, pool, "old-slice-policy")
	storageID := uuid.NewString()
	hxExec(t, ctx, pool, `INSERT INTO workspace_slice_storage(id,org_id,created_by,endpoint,bucket,public_base_url,access_key_hint,secret_nonce,secret_ciphertext)
		VALUES($1::uuid,$2,$3,'https://old.invalid','old-bucket','https://old.invalid','test','x','x')`, storageID, org, owner)
	boundary := time.Date(2026, 10, 15, 20, 0, 0, 0, time.UTC)
	hxExec(t, ctx, pool, `INSERT INTO transit_clear_runs(bucket_identity,run_day,status,lease_epoch,started_at,next_attempt_at,completed_at,updated_at)
		VALUES($1,'2026-10-16','completed',1,$2,$2,$2,$2)`, media.SliceClearIdentity("daily", storageID), boundary.Add(time.Hour))
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var minute int
	var fence time.Time
	if err := pool.QueryRow(ctx, `SELECT clear_at_minute,clear_fence_at FROM workspace_slice_storage WHERE id=$1::uuid`, storageID).Scan(&minute, &fence); err != nil || minute != 240 || !fence.Equal(boundary) {
		t.Fatalf("old schedule or clear fence was lost: %d %s %v", minute, fence, err)
	}
}

func TestWorkspaceSliceCleanupPolicy(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	owner, org, workspace := securityOrg(t, ctx, pool, "slice-cleanup-policy")
	insertMember(t, ctx, pool, org, owner, "owner", 1)
	tokenHash := fmt.Sprintf("%x", sha256.Sum256([]byte(workspace)))
	hxExec(t, ctx, pool, `UPDATE account_profiles SET active_org_id=$2 WHERE user_id=$1`, owner, org)
	hxExec(t, ctx, pool, `INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($2,$1,clock_timestamp()+interval '1 hour')`, owner, tokenHash)
	seedMatchingLease(t, ctx, pool, "recipe", "slice cleanup policy")
	key := []byte("12345678901234567890123456789012")
	account := sign.Account{ID: uuid.NewString(), Endpoint: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com", Bucket: "cleanup-policy-test", PublicBaseURL: "https://pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev", AccessKeyID: "access", SecretAccessKey: "secret"}
	if err := db.InTx(ctx, pool, db.App(org), func(tx pgx.Tx) error {
		if err := mediarepo.StageSliceStorage(ctx, tx, org, owner, account, key); err != nil {
			return err
		}
		return mediarepo.ActivateSliceStorage(ctx, tx, org, owner, account.ID)
	}); err != nil {
		t.Fatal(err)
	}
	principal := &access.Principal{UserID: owner, OrgID: org, WorkspaceRole: "owner", PlatformRole: "user", TokenHash: tokenHash}
	s := &httpapi.Server{Pool: pool, Access: access.FixedResolver{Principal: principal}, SliceStorageKey: key, SliceDeleteAllowed: true}
	s.Workspace = func(context.Context, int64) (string, error) { return workspace, nil }
	handler := httpapi.HandlerFromMux(s, nil)
	call := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, req)
		return out
	}
	assertPolicy := func(out *httptest.ResponseRecorder, mode string, at any) {
		t.Helper()
		var got map[string]any
		if out.Code != http.StatusOK || json.Unmarshal(out.Body.Bytes(), &got) != nil || got["cleanup_mode"] != mode || got["cleanup_time"] != at {
			t.Fatalf("policy response: %d %s", out.Code, out.Body.String())
		}
	}
	path := "/api/workspace/slice-storage/cleanup"
	assertPolicy(call(http.MethodGet, "/api/workspace/slice-storage", ""), "daily", "04:00")
	for _, body := range []string{`{"cleanup_mode":"daily","cleanup_time":"24:00"}`, `{"cleanup_mode":"daily"}`, `{"cleanup_mode":"manual","cleanup_time":"04:00"}`, `{"cleanup_mode":"other"}`} {
		if got := call(http.MethodPatch, path, body); got.Code != http.StatusBadRequest {
			t.Fatalf("invalid policy accepted: %s: %d %s", body, got.Code, got.Body.String())
		}
	}
	principal.WorkspaceRole = "member"
	if got := call(http.MethodPatch, path, `{"cleanup_mode":"manual","cleanup_time":null}`); got.Code != http.StatusForbidden {
		t.Fatalf("member changed cleanup: %d %s", got.Code, got.Body.String())
	}
	principal.WorkspaceRole = "owner"
	assertPolicy(call(http.MethodPatch, path, `{"cleanup_mode":"manual","cleanup_time":null}`), "manual", nil)
	fingerprint := media.SliceClearIdentity("daily", account.ID)
	if claim, err := slicepurge.TryClaimScheduled(ctx, pool, fingerprint, org, account.ID); err != nil || claim != nil {
		t.Fatalf("manual mode started automatic clear: %v %v", claim, err)
	}
	assertPolicy(call(http.MethodPatch, path, `{"cleanup_mode":"daily","cleanup_time":"00:00"}`), "daily", "00:00")
	if claim, err := slicepurge.TryClaimScheduled(ctx, pool, fingerprint, org, account.ID); err != nil || claim != nil {
		t.Fatalf("new schedule deleted before its next occurrence: %v %v", claim, err)
	}
	hxExec(t, ctx, pool, `UPDATE workspace_slice_storage SET clear_configured_at=clock_timestamp()-interval '2 days' WHERE id=$1::uuid`, account.ID)
	claim, err := slicepurge.TryClaimScheduled(ctx, pool, fingerprint, org, account.ID)
	if err != nil || claim == nil {
		t.Fatalf("due schedule was not claimed: %v", err)
	}
	var fence *time.Time
	if err := pool.QueryRow(ctx, `SELECT clear_fence_at FROM workspace_slice_storage WHERE id=$1::uuid`, account.ID).Scan(&fence); err != nil || fence != nil {
		t.Fatalf("automatic cleanup invalidated protected batches: %v, %v", fence, err)
	}
	if got := call(http.MethodPatch, path, `{"cleanup_mode":"manual","cleanup_time":null}`); got.Code != http.StatusConflict {
		t.Fatalf("changed policy during active deletion: %d %s", got.Code, got.Body.String())
	}
	local := time.Now().In(media.Shanghai())
	if local.Hour()*60+local.Minute() >= 1 {
		reservation, ok, err := claim.Reserve(ctx)
		if err != nil || !ok {
			t.Fatalf("reserve: %v", err)
		}
		if ok, err := claim.Record(ctx, reservation, 0, 0); err != nil || !ok {
			t.Fatalf("record: %v", err)
		}
		if ok, err := claim.Finish(ctx); err != nil || !ok {
			t.Fatalf("finish: %v", err)
		}
		// Simulate changing the schedule after midnight and reaching the new time.
		hxExec(t, ctx, pool, `UPDATE workspace_slice_storage SET clear_at_minute=1,clear_configured_at=$2::timestamptz + interval '30 seconds' WHERE id=$1::uuid`, account.ID, claim.Boundary())
		claim, err = slicepurge.TryClaimScheduled(ctx, pool, fingerprint, org, account.ID)
		if err != nil || claim == nil || claim.Boundary().In(media.Shanghai()).Format("15:04") != "00:01" {
			t.Fatalf("changed schedule did not run at its next time: %v %v", claim, err)
		}
	}
	if ok, err := claim.RetryLater(ctx, "slice_wait_uploads"); err != nil || !ok {
		t.Fatalf("could not release cleanup: %v", err)
	}
	assertPolicy(call(http.MethodPatch, path, `{"cleanup_mode":"manual","cleanup_time":null}`), "manual", nil)
	if claim, err := slicepurge.TryClaimScheduled(ctx, pool, fingerprint, org, account.ID); err != nil || claim != nil {
		t.Fatalf("manual mode retried automatic clear: %v %v", claim, err)
	}
	if got := call(http.MethodPost, "/api/workspace/slice-storage/clear", ""); got.Code != http.StatusAccepted {
		t.Fatalf("manual clear unavailable: %d %s", got.Code, got.Body.String())
	}
}
