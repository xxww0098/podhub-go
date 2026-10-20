package billingrepo

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// countingPool never reaches a server. Each Begin dials, so the counter is
// the number of transactions the code tried to open.
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
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws := "00000000-0000-4000-8000-000000000001"
	internal := RedeemError{Status: 500, Code: "INTERNAL", Message: "兑换失败"}
	for _, org := range []int64{0, -1} {
		_, err := Redeem(ctx, pool, org, 1, "CODE", ws)
		var re *RedeemError
		if !errors.As(err, &re) || *re != internal {
			t.Fatalf("Redeem org=%d: %v", org, err)
		}
		if err := replayTopup(ctx, pool, 1, "p", org, 100); !errors.Is(err, tenantx.ErrOrgUnset) {
			t.Fatalf("replayTopup org=%d: %v", org, err)
		}
	}
	if n := dials.Load(); n != 0 {
		t.Fatalf("org unset dialed %d times", n)
	}
	_, err := Redeem(ctx, pool, 1, 1, "CODE", ws)
	var re *RedeemError
	if !errors.As(err, &re) || *re != internal {
		t.Fatalf("Redeem org=1 with no server: %v", err)
	}
	if dials.Load() == 0 {
		t.Fatal("control call did not dial; the counter proves nothing")
	}
}
