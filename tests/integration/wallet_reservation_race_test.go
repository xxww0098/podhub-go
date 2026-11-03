package integration

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
)

func TestWalletReservationSerializesTransitions(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "billing", "wallet transition races")
	t.Cleanup(func() {
		if err := purgeAIFixtures(context.Background(), pool); err != nil {
			t.Error(err)
		}
	})
	for i, scenario := range []string{"same hold replay", "settlement versus release"} {
		t.Run(scenario, func(t *testing.T) {
			org, _ := seedAITenant(t, ctx, pool, int64(96971+i))
			if _, err := billingrepo.Adjust(ctx, pool, org, "seed", 1000, "seed"); err != nil {
				t.Fatal(err)
			}
			if i == 1 {
				tx, err := pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(ctx)
				for _, key := range []string{"race", "other request"} {
					if _, err = billingrepo.HoldTx(ctx, tx, org, key, nil, 500); err != nil {
						t.Fatal(err)
					}
				}
				if err := tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
			}
			calls := [2]func(pgx.Tx) error{}
			if i == 0 {
				calls[0] = func(tx pgx.Tx) error {
					_, err := billingrepo.HoldTx(ctx, tx, org, "race", nil, 500)
					return err
				}
				calls[1] = calls[0]
			} else {
				calls[0] = func(tx pgx.Tx) error {
					_, err := billingrepo.SettleTx(ctx, tx, org, "race", nil, 500, 100)
					return err
				}
				calls[1] = func(tx pgx.Tx) error {
					_, err := billingrepo.ReleaseTx(ctx, tx, org, "race", nil, 500, "cancel")
					return err
				}
			}
			errs := runBlockedWalletCalls(t, ctx, pool, org, calls)
			succeeded := 0
			for _, err := range errs {
				if err == nil {
					succeeded++
				}
			}
			wantSuccess := 2 - i
			if succeeded != wantSuccess {
				t.Errorf("successful calls=%d want=%d errors=%v", succeeded, wantSuccess, errs)
			}
			var held, holdEntries, terminalEntries int64
			if err := pool.QueryRow(ctx, `SELECT held_microfen FROM workspace_wallets WHERE org_id=$1`, org).Scan(&held); err != nil {
				t.Fatal(err)
			}
			if err := pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE entry_type='hold'),count(*) FILTER(WHERE entry_type IN('settle','release')) FROM wallet_ledger WHERE org_id=$1 AND idempotency_key='race'`, org).Scan(&holdEntries, &terminalEntries); err != nil {
				t.Fatal(err)
			}
			if held != 500 || holdEntries != 1 || terminalEntries != int64(i) {
				t.Errorf("reservation corrupted: held=%d hold entries=%d terminal entries=%d", held, holdEntries, terminalEntries)
			}
		})
	}
	t.Run("same payment topup replay", func(t *testing.T) {
		org, user := seedAITenant(t, ctx, pool, 96973)
		if _, err := billingrepo.Adjust(ctx, pool, org, "seed", 1000, "seed"); err != nil {
			t.Fatal(err)
		}
		var order int64
		if err := pool.QueryRow(ctx, `INSERT INTO payment_orders
			(public_id,org_id,plan,months,amount_cents,currency,provider,status,created_by_user_id,created_at,updated_at,product,topup_microfen)
			VALUES('wallet-race-payment',$1,'lite',1,100,'CNY','alipay','paid',$2,clock_timestamp(),clock_timestamp(),'wallet_topup',100000000) RETURNING id`, org, user).Scan(&order); err != nil {
			t.Fatal(err)
		}
		call := func(tx pgx.Tx) error {
			_, err := billingrepo.TopupTx(ctx, tx, org, "wallet-race-payment", order, 100000000)
			return err
		}
		for _, err := range runBlockedWalletCalls(t, ctx, pool, org, [2]func(pgx.Tx) error{call, call}) {
			if err != nil {
				t.Error(err)
			}
		}
		var balance, entries int64
		if err := pool.QueryRow(ctx, `SELECT balance_microfen,(SELECT count(*) FROM wallet_ledger WHERE org_id=$1 AND entry_type='topup') FROM workspace_wallets WHERE org_id=$1`, org).Scan(&balance, &entries); err != nil {
			t.Fatal(err)
		}
		if balance != 100001000 || entries != 1 {
			t.Fatalf("topup replay changed balance=%d entries=%d", balance, entries)
		}
	})
}

func TestWalletLocksAreScopedToOneWorkspace(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "billing", "wallet workspace isolation")
	t.Cleanup(func() {
		if err := purgeAIFixtures(context.Background(), pool); err != nil {
			t.Error(err)
		}
	})
	orgA, user := seedAITenant(t, ctx, pool, 96975)
	// A second workspace of the same owner has its own wallet row.
	var orgB int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, 'org-second', 'lite', clock_timestamp(), clock_timestamp()) RETURNING id`, user).Scan(&orgB); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{orgA, orgB} {
		if _, err := billingrepo.Adjust(ctx, pool, id, "seed", 1000, "seed"); err != nil {
			t.Fatal(err)
		}
	}
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `SELECT 1 FROM workspace_wallets WHERE org_id=$1 FOR UPDATE`, orgA); err != nil {
		t.Fatal(err)
	}
	// orgB holds while orgA's wallet row is locked: the lock does not cross workspaces.
	hold := func(id int64, key string, amount int64) error {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := billingrepo.HoldTx(ctx, tx, id, key, nil, amount); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if err := hold(orgB, "iso", 600); err != nil {
		t.Fatal(err)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var balanceA, heldA, balanceB, heldB int64
	if err := pool.QueryRow(ctx, `SELECT balance_microfen, held_microfen FROM workspace_wallets WHERE org_id=$1`, orgA).Scan(&balanceA, &heldA); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT balance_microfen, held_microfen FROM workspace_wallets WHERE org_id=$1`, orgB).Scan(&balanceB, &heldB); err != nil {
		t.Fatal(err)
	}
	if balanceA != 1000 || heldA != 0 || balanceB != 1000 || heldB != 600 {
		t.Fatalf("orgA %d/%d orgB %d/%d, want 1000/0 and 1000/600", balanceA, heldA, balanceB, heldB)
	}
	// orgA still has its full 1000 available, orgB only 400.
	if err := hold(orgA, "iso-a", 1000); err != nil {
		t.Fatalf("orgA hold of its own full balance: %v", err)
	}
	if err := hold(orgB, "iso-b", 500); err == nil {
		t.Fatal("orgB held more than its available balance")
	}
}

func runBlockedWalletCalls(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, calls [2]func(pgx.Tx) error) []error {
	t.Helper()
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `SELECT 1 FROM workspace_wallets WHERE org_id=$1 FOR UPDATE`, org); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, len(calls))
	pids := make([]int32, len(calls))
	for i, call := range calls {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		pids[i] = int32(tx.Conn().PgConn().PID())
		go func() {
			defer tx.Rollback(ctx)
			if err := call(tx); err != nil {
				results <- err
				return
			}
			results <- tx.Commit(ctx)
		}()
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'`, pids).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting == len(calls) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("wallet calls did not reach lock: %d/%d", waiting, len(calls))
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return []error{<-results, <-results}
}
