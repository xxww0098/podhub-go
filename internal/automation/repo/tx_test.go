package automationrepo

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/automation/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
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

func isUnavailable(err error) bool {
	var fault *contract.Fault
	want := contract.Unavailable()
	return errors.As(err, &fault) && *fault == *want
}

func TestOrgUnsetOpensNoTransaction(t *testing.T) {
	pool, dials := countingPool(t)
	r := New(pool, tenantx.BeginApp)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	calls := map[string]func(int64) error{
		"ListAssetSets":  func(org int64) error { _, err := r.ListAssetSets(ctx, org, 1); return err },
		"CreateAssetSet": func(org int64) error { _, err := r.CreateAssetSet(ctx, org, 1, "n", nil); return err },
		"Claim":          func(org int64) error { _, err := r.Claim(ctx, org, 1, "rt", 1); return err },
		"Renew":          func(org int64) error { _, err := r.Renew(ctx, org, 1, "rt", nil, nil); return err },
		"Progress":       func(org int64) error { _, err := r.Progress(ctx, org, 1, "id", 1, nil); return err },
		"Settle":         func(org int64) error { _, err := r.Settle(ctx, org, 1, "id", 1, "done", nil, nil); return err },
		"ListRuntimes":   func(org int64) error { _, err := r.ListRuntimes(ctx, org, 1); return err },
		"RegisterRuntime": func(org int64) error {
			_, err := r.RegisterRuntime(ctx, org, 1, "g", "l", "r")
			return err
		},
		"DeregisterRuntime": func(org int64) error { _, err := r.DeregisterRuntime(ctx, org, 1, "id"); return err },
		"HeartbeatRuntime":  func(org int64) error { _, err := r.HeartbeatRuntime(ctx, org, 1, "id"); return err },
	}
	for name, call := range calls {
		for _, org := range []int64{0, -1} {
			if err := call(org); !isUnavailable(err) {
				t.Fatalf("%s org=%d: err = %v, want Unavailable", name, org, err)
			}
		}
	}
	if n := dials.Load(); n != 0 {
		t.Fatalf("org unset dialed %d times", n)
	}
	if err := calls["ListRuntimes"](1); !isUnavailable(err) {
		t.Fatalf("org=1 with no server: err = %v, want Unavailable", err)
	}
	if dials.Load() == 0 {
		t.Fatal("control call did not dial; the counter proves nothing")
	}
}
