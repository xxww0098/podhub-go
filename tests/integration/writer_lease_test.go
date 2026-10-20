package integration

import (
	"context"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// TestWriterLeaseHeartbeatsAsPodhubApp is the production role path: the whole
// check, insert, and heartbeat run as podhub_app, which m20260920_000329 already
// grants on writer_leases.
func TestWriterLeaseHeartbeatsAsPodhubApp(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	if _, err := pool.Exec(ctx, `DELETE FROM writer_leases WHERE domain = 'admin'`); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	id := writer.Identity{Holder: writer.HolderAxum, InstanceID: "axum-lease-test"}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	var role string
	if err := tx.QueryRow(ctx, `SELECT current_user`).Scan(&role); err != nil {
		t.Fatal(err)
	}
	if role != "podhub_app" {
		t.Fatalf("role %s", role)
	}
	held, err := writer.Assert(ctx, tx, "admin", id, now, "管理域写入未启用")
	if !writer.IsDisabled(err) || held.ID != nil || held.Fence != nil {
		t.Fatalf("empty domain held %+v err %v", held, err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO writer_leases (
			domain, holder, holder_instance, fence_token, granted_at_ms, expires_at_ms, heartbeat_at_ms, grant_reason)
		VALUES ('admin', 'axum', 'axum-lease-test', 7, $1::bigint, $1::bigint + 1000, $1::bigint - 1000, 'test')`, now); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	writer.Forget(tx)

	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	held, err = writer.Assert(ctx, tx, "admin", id, now, "管理域写入未启用")
	if err != nil || held.ID == nil || held.Fence == nil || *held.Fence != 7 {
		t.Fatalf("matching lease %+v err %v", held, err)
	}
	var beat, exp int64
	if err := tx.QueryRow(ctx, `
		SELECT heartbeat_at_ms, expires_at_ms FROM writer_leases WHERE id = $1`, *held.ID).Scan(&beat, &exp); err != nil {
		t.Fatal(err)
	}
	if beat != now || exp != now+writer.LeaseTTLMS {
		t.Fatalf("heartbeat %d expires %d", beat, exp)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	writer.Forget(tx)

	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	_, err = writer.Assert(ctx, tx, "admin", writer.Identity{Holder: writer.HolderAxum, InstanceID: "other"}, now, "管理域写入未启用")
	if !writer.IsDisabled(err) || err.Error() != "管理域写入未启用" {
		t.Fatalf("foreign %v", err)
	}
	writer.Forget(tx)
}
