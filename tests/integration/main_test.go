package integration

import (
	"context"
	"flag"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

// TestMain migrates one template database on a shared Postgres container.
// migrateTemplate calls db.Migrate, so the template uses the same
// allow-missing Up as production. An empty database has no gap, and that
// Up applies every file in version order.
func TestMain(m *testing.M) {
	// flag.Parse has not run yet. Listing should not start Postgres.
	flag.Parse()
	if f := flag.Lookup("test.list"); f != nil && f.Value.String() != "" {
		os.Exit(m.Run())
	}
	code := 1
	defer func() {
		testkit.ShutdownSharedPostgres()
		os.Exit(code)
	}()
	if os.Getenv("PODHUB_PARITY_DSN") == "" && testkit.DockerAvailable() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		err := testkit.PrepareMigratedTemplate(ctx, migrateTemplate)
		cancel()
		if err != nil {
			fmt.Fprintf(os.Stderr, "prepare migrated template: %v\n", err)
			return
		}
	}
	code = reportSpecFailures(m.Run())
}

func migrateTemplate(ctx context.Context, dsn string) error {
	if err := (config.Config{DatabaseURL: dsn}).CheckDatabase(); err != nil {
		return err
	}
	// Tests dial the postgres role. Production refuses that login.
	_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	pool, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		return err
	}
	defer pool.Close()
	return db.Migrate(ctx, pool)
}
