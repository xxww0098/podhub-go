package telemetryrepo

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/telemetry/domain"
)

func TestTenantWritesStayInOrg(t *testing.T) {
	pool, ctx := telemetryBatchDB(t)
	userA, userB := int64(883101), int64(883102)
	orgA := seedTelemetryOrg(t, ctx, pool, userA)
	orgB := seedTelemetryOrg(t, ctx, pool, userB)
	fp := strings.Repeat("c", 64)
	t.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `DELETE FROM client_listing_logs WHERE user_id IN ($1, $2)`, userA, userB)
		_, _ = pool.Exec(c, `DELETE FROM error_digest WHERE fingerprint = $1`, fp)
		for _, org := range []int64{orgA, orgB} {
			_, _ = pool.Exec(c, `DELETE FROM organization_members WHERE org_id = $1`, org)
			_, _ = pool.Exec(c, `DELETE FROM organizations WHERE id = $1`, org)
		}
		_, _ = pool.Exec(c, `DELETE FROM account_users WHERE id IN ($1, $2)`, userA, userB)
	})
	repo := New(pool)
	at := time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
	if err := repo.InsertClientLogs(ctx, orgA, userA, []domain.ClientLog{sampleLog(1, at, "rls"), sampleLog(2, at, "rls")}); err != nil {
		t.Fatal(err)
	}
	window := at.Truncate(time.Hour)
	if err := repo.SaveDigest(ctx, []domain.DigestRow{{
		OrgID: orgA, Fingerprint: fp, RouteTemplate: "/api/rls", StatusCode: 500, Count: 2,
		FirstAt: at, LastAt: at, Summary: "rls", WindowStart: window,
	}}); err != nil {
		t.Fatal(err)
	}
	mismatch := []domain.DigestRow{{OrgID: orgB, Fingerprint: fp, RouteTemplate: "/api/rls", StatusCode: 500, Count: 1,
		FirstAt: at, LastAt: at, Summary: "rls", WindowStart: window}}
	if err := repo.saveTenant(ctx, orgA, mismatch); err == nil {
		t.Fatal("saveTenant wrote a row for another org")
	}

	count := func(org int64) (logs, digest int) {
		t.Helper()
		tx, err := tenantx.BeginApp(ctx, pool.Begin, org)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM client_listing_logs WHERE user_id = $1`, userA).Scan(&logs); err != nil {
			t.Fatal(err)
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM error_digest WHERE fingerprint = $1`, fp).Scan(&digest); err != nil {
			t.Fatal(err)
		}
		return logs, digest
	}
	if logs, digest := count(orgA); logs != 2 || digest != 1 {
		t.Fatalf("org A sees logs=%d digest=%d", logs, digest)
	}
	if logs, digest := count(orgB); logs != 0 || digest != 0 {
		t.Fatalf("org B sees org A rows: logs=%d digest=%d", logs, digest)
	}
	var total int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM error_digest WHERE fingerprint = $1`, fp).Scan(&total); err != nil || total != 1 {
		t.Fatalf("digest rows %d %v", total, err)
	}
}

// countingPool never reaches a server. Each Begin dials, so the counter is
// the number of transactions the repo tried to open.
func countingPool(t *testing.T) (*pgxpool.Pool, *atomic.Int32) {
	t.Helper()
	cfg, err := pgxpool.ParseConfig("postgres://u:p@127.0.0.1:1/db?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	var dials atomic.Int32
	cfg.BeforeConnect = func(context.Context, *pgx.ConnConfig) error {
		dials.Add(1)
		return errors.New("no server")
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, &dials
}

func TestOrgUnsetOpensNoTransaction(t *testing.T) {
	pool, dials := countingPool(t)
	repo := New(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	logs := []domain.ClientLog{sampleLog(1, time.Now(), "x")}
	for _, org := range []int64{0, -1} {
		if err := repo.InsertClientLogs(ctx, org, 1, logs); err == nil || *err.(*domain.Fail) != *domain.LogsNotWritten() {
			t.Fatalf("InsertClientLogs org=%d: %v", org, err)
		}
		if err := repo.saveTenant(ctx, org, nil); err == nil || *err.(*domain.Fail) != *domain.Unavailable() {
			t.Fatalf("saveTenant org=%d: %v", org, err)
		}
	}
	if n := dials.Load(); n != 0 {
		t.Fatalf("org unset dialed %d times", n)
	}
	if err := repo.InsertClientLogs(ctx, 1, 1, logs); err == nil {
		t.Fatal("org=1 with no server succeeded")
	}
	if dials.Load() == 0 {
		t.Fatal("control call did not dial; the counter proves nothing")
	}
}
