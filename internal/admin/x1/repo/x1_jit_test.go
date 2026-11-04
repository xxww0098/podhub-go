package x1repo

import (
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestSupplierRowsJITIsLimitedToTransaction(t *testing.T) {
	pool, ctx := x1ParityDB(t)
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()

	var baseline string
	if err := conn.QueryRow(ctx, `SHOW jit`).Scan(&baseline); err != nil {
		t.Fatal(err)
	}
	for _, single := range []bool{false, true} {
		name := "list"
		if single {
			name = "single"
		}
		t.Run(name, func(t *testing.T) {
			tx, err := conn.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if _, err := tx.Exec(ctx, `SET LOCAL jit = on`); err != nil {
				t.Fatal(err)
			}
			if err := tenantx.EnterApp(ctx, tx, 1); err != nil {
				t.Fatal(err)
			}
			if _, err := tx.Exec(ctx, `SET LOCAL app.staff_access = '1'`); err != nil {
				t.Fatal(err)
			}
			if single {
				if _, err := loadRow(ctx, tx, "src_jit_missing", "scp_jit_missing", 0); err == nil || err.Error() != "记录不存在或已删除" {
					t.Fatalf("missing row: %v", err)
				}
			} else if rows, err := loadRows(ctx, tx, "src_jit_missing", 0); err != nil || len(rows) != 0 {
				t.Fatalf("empty rows: %v, %v", rows, err)
			}
			var current string
			if err := tx.QueryRow(ctx, `SHOW jit`).Scan(&current); err != nil || current != "off" {
				t.Fatalf("transaction jit = %q, error %v", current, err)
			}
			if err := tx.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			if err := conn.QueryRow(ctx, `SHOW jit`).Scan(&current); err != nil || current != baseline {
				t.Fatalf("connection jit = %q, want %q, error %v", current, baseline, err)
			}
		})
	}
}
