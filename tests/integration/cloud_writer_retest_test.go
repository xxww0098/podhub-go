package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

func cleanupBootstrapLease(t *testing.T, ctx context.Context, pool *pgxpool.Pool, instance string) {
	t.Helper()
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM writer_lease_events WHERE holder_instance = $1`, instance); err != nil {
			t.Error(err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM writer_leases WHERE holder_instance = $1`, instance); err != nil {
			t.Error(err)
		}
	})
}

func TestCloudRetestExpiredBootstrapSuccessIsUsable(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	now := time.Now().UnixMilli()
	instance := "retest-" + uuid.NewString()
	cleanupBootstrapLease(t, ctx, pool, instance)
	_, err := writer.Bootstrap(ctx, pool.Begin, "recipe", instance, "synthetic expired bootstrap", now-2*writer.LeaseTTLMS)
	if err != nil {
		t.Fatal(err)
	}
	id, err := writer.Bootstrap(ctx, pool.Begin, "recipe", instance, "synthetic rebootstrap", now)
	if !errors.Is(err, writer.ErrLeaseExpired) || id != 0 {
		t.Fatalf("expired bootstrap = %d, %v; want 0, ErrLeaseExpired", id, err)
	}
	t.Logf("expired bootstrap correctly refused: %v", err)
}

func TestCloudRetestBootstrapLeaseContract(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	now := time.Now().UnixMilli()
	for _, tc := range []struct {
		name, holder      string
		differentInstance bool
		expiry, heartbeat int64
		wantErr           error
	}{
		{"live", writer.HolderAxum, false, now + writer.LeaseTTLMS, now, nil},
		{"expiry_boundary", writer.HolderAxum, false, now, now, writer.ErrLeaseExpired},
		{"stale_heartbeat", writer.HolderAxum, false, now + writer.LeaseTTLMS, now - writer.LeaseTTLMS, writer.ErrLeaseExpired},
		{"foreign_live", writer.HolderAxum, true, now + writer.LeaseTTLMS, now, writer.ErrLeaseHeld},
		{"foreign_expired", writer.HolderAxum, true, now, now - writer.LeaseTTLMS, writer.ErrLeaseHeld},
		{"foreign_holder", "hono", false, now + writer.LeaseTTLMS, now, writer.ErrLeaseHeld},
	} {
		t.Run(tc.name, func(t *testing.T) {
			instance := "retest-" + uuid.NewString()
			cleanupBootstrapLease(t, ctx, pool, instance)
			id, err := writer.Bootstrap(ctx, pool.Begin, "recipe", instance, "synthetic bootstrap contract", now-writer.LeaseTTLMS)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `UPDATE writer_leases SET holder=$2, expires_at_ms=$3, heartbeat_at_ms=$4 WHERE id=$1`, id, tc.holder, tc.expiry, tc.heartbeat); err != nil {
				t.Fatal(err)
			}
			var fence, events int64
			if err := pool.QueryRow(ctx, `SELECT fence_token, (SELECT count(*) FROM writer_lease_events WHERE lease_id=$1) FROM writer_leases WHERE id=$1`, id).Scan(&fence, &events); err != nil {
				t.Fatal(err)
			}
			caller := instance
			if tc.differentInstance {
				caller += "-other"
			}
			again, err := writer.Bootstrap(ctx, pool.Begin, "recipe", caller, "synthetic rebootstrap", now)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("bootstrap error=%v, want %v", err, tc.wantErr)
			}
			if tc.wantErr == nil && again != id {
				t.Fatalf("id=%d, want %d", again, id)
			}
			if tc.wantErr != nil && again != 0 {
				t.Fatalf("failed bootstrap returned id=%d", again)
			}
			var afterFence, afterEvents, expiry, heartbeat int64
			if err := pool.QueryRow(ctx, `SELECT fence_token, expires_at_ms, heartbeat_at_ms, (SELECT count(*) FROM writer_lease_events WHERE lease_id=$1) FROM writer_leases WHERE id=$1`, id).Scan(&afterFence, &expiry, &heartbeat, &afterEvents); err != nil {
				t.Fatal(err)
			}
			if afterFence != fence || afterEvents != events || expiry != tc.expiry || heartbeat != tc.heartbeat {
				t.Fatalf("bootstrap mutated existing lease: fence=%d expiry=%d heartbeat=%d events=%d", afterFence, expiry, heartbeat, afterEvents)
			}
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			defer writer.Forget(tx)
			held, err := writer.Assert(ctx, tx, "recipe", writer.Identity{Holder: writer.HolderAxum, InstanceID: caller}, now, "writer disabled")
			if tc.wantErr == nil {
				if err != nil || held.ID == nil || *held.ID != id || held.Fence == nil || *held.Fence != fence {
					t.Fatalf("successful bootstrap unusable: held=%+v err=%v", held, err)
				}
			} else if !writer.IsDisabled(err) {
				t.Fatalf("rejected lease Assert=%v, want disabled", err)
			}
		})
	}
	t.Run("revoked_gets_new_fence", func(t *testing.T) {
		instance := "retest-" + uuid.NewString()
		cleanupBootstrapLease(t, ctx, pool, instance)
		id, err := writer.Bootstrap(ctx, pool.Begin, "recipe", instance, "synthetic old grant", now)
		if err != nil {
			t.Fatal(err)
		}
		var oldFence int64
		if err := pool.QueryRow(ctx, `UPDATE writer_leases SET revoked_at_ms=$2 WHERE id=$1 RETURNING fence_token`, id, now).Scan(&oldFence); err != nil {
			t.Fatal(err)
		}
		next, err := writer.Bootstrap(ctx, pool.Begin, "recipe", instance, "synthetic new grant", now)
		if err != nil || next == id {
			t.Fatalf("new bootstrap=%d %v", next, err)
		}
		var newFence, revoked int64
		if err := pool.QueryRow(ctx, `SELECT fence_token, (SELECT revoked_at_ms FROM writer_leases WHERE id=$2) FROM writer_leases WHERE id=$1`, next, id).Scan(&newFence, &revoked); err != nil {
			t.Fatal(err)
		}
		if newFence <= oldFence || revoked != now {
			t.Fatalf("revocation/fence lost: old=%d new=%d revoked=%d", oldFence, newFence, revoked)
		}
	})
}
