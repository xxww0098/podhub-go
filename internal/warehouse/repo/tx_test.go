package warehouserepo

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/warehouse/contract"
)

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
	r := New(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	unavailable := contract.Unavailable().Error()
	calls := map[string]func(int64) error{
		"SaveSnapshot": func(org int64) error { return r.SaveSnapshot(ctx, org, "s", contract.Snapshot{}) },
		"ListWarehouses": func(org int64) error {
			_, _, err := r.ListWarehouses(ctx, org, "s")
			return err
		},
		"GetWarehouse": func(org int64) error { _, err := r.GetWarehouse(ctx, org, "s", 1); return err },
		"ListRFBS":     func(org int64) error { _, err := r.ListRFBS(ctx, org, "s"); return err },
		"ListMethods":  func(org int64) error { _, err := r.ListMethods(ctx, org, "s", 1); return err },
		"GetMethod":    func(org int64) error { _, err := r.GetMethod(ctx, org, "s", 1); return err },
		"PrepareGrant": func(org int64) error {
			_, err := r.PrepareGrant(ctx, contract.GrantWrite{OrgID: org})
			return err
		},
		"ApplyReport": func(org int64) error {
			_, err := r.ApplyReport(ctx, contract.ReportWrite{OrgID: org})
			return err
		},
		"FindOperation": func(org int64) error { _, err := r.FindOperation(ctx, org, "s", "op"); return err },
	}
	for name, call := range calls {
		for _, org := range []int64{0, -1} {
			if err := call(org); err == nil || err.Error() != unavailable {
				t.Fatalf("%s org=%d: err = %v, want Unavailable", name, org, err)
			}
		}
	}
	if err := r.AuditRefused(ctx, 0, 1, "s", "create"); err != nil {
		t.Fatalf("AuditRefused org=0: %v", err)
	}
	if n := dials.Load(); n != 0 {
		t.Fatalf("org unset dialed %d times", n)
	}
	if err := calls["ListRFBS"](1); err == nil || err.Error() != unavailable {
		t.Fatalf("org=1 with no server: err = %v, want Unavailable", err)
	}
	if dials.Load() == 0 {
		t.Fatal("control call did not dial; the counter proves nothing")
	}
}
