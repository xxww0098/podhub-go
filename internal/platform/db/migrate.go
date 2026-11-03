// Package db opens a loopback pool and applies goose plus River migrations.
package db

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"net"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"

	"github.com/xxww0098/podhub-go/db"
	"github.com/xxww0098/podhub-go/internal/platform/config"
)

// squashedMax is the highest version of the squashed baseline. The history was
// collapsed from 329 files into three, so a database that records a higher
// version came from the old chain. The guard test in this package keeps this
// equal to the files on disk.
const squashedMax int64 = 3

// Connect checks the host, then dials. An empty URL is an error here.
// Every new connection refuses a superuser or BYPASSRLS login unless
// PODHUB_ALLOW_SUPERUSER_DB is exactly 1. Ping forces that check before
// the pool is returned, so startup fails closed.
func Connect(ctx context.Context, cfg config.Config) (*pgxpool.Pool, error) {
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is empty")
	}
	if err := cfg.CheckDatabase(); err != nil {
		return nil, err
	}
	poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	// Database service names need local DNS even when outbound DNS is overridden.
	poolCfg.ConnConfig.LookupFunc = (&net.Resolver{}).LookupHost
	poolCfg.AfterConnect = rejectPrivilegedLogin
	poolCfg.ConnConfig.Tracer = queryTracer{}
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// Migrate applies the goose skeleton and River's schema.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	if err := gooseUp(ctx, pool); err != nil {
		return err
	}
	if err := riverUp(ctx, pool); err != nil {
		return err
	}
	return grantRiverRuntime(ctx, pool)
}

func gooseUp(ctx context.Context, pool *pgxpool.Pool) error {
	goose.SetBaseFS(dbschema.Migrations)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	// The history is squashed to three files with contiguous versions, so a
	// gap can no longer exist and the default Up is the strict one.
	if err := goose.UpContext(ctx, sqlDB, "migrations"); err != nil {
		return err
	}
	return checkSquashedHistory(ctx, sqlDB)
}

// checkSquashedHistory refuses a database left on the pre-squash chain.
//
// The history was collapsed from 329 files into three. A database migrated by
// the old chain therefore records versions this build does not ship, and its
// highest is 368. goose.Up compares only against the files it can see, so a
// file added later as 00004 collides with the old chain's 00004 and is treated
// as already applied: it would be skipped without any error. Version numbers
// alone cannot tell the two apart, so this checks the recorded set instead.
//
// This build ships 00004, so every old-chain database is now refused rather
// than left at head: it would silently miss the drop of the verifier tables.
func checkSquashedHistory(ctx context.Context, sqlDB *sql.DB) error {
	applied, err := appliedVersions(ctx, sqlDB)
	if err != nil {
		return err
	}
	shipped, err := shippedVersions()
	if err != nil {
		return err
	}
	foreign, ok := foreignApplied(applied, shipped)
	if !ok {
		return nil
	}
	return fmt.Errorf(
		"database records migration %d, which this build does not ship: it "+
			"was migrated by the pre-squash history, so goose would treat "+
			"newer files with the same number as already applied; rebase it "+
			"onto the squashed baseline (dev: RESET_DB=1) before adding "+
			"migrations",
		foreign)
}

// foreignApplied reports an applied version this build does not ship, but only
// once a shipped file sits above the baseline. Below that point the pre-squash
// database is at head and has nothing to miss.
func foreignApplied(applied map[int64]bool, shipped []int64) (int64, bool) {
	shippedSet := make(map[int64]bool, len(shipped))
	var highest int64
	for _, version := range shipped {
		shippedSet[version] = true
		if version > highest {
			highest = version
		}
	}
	if highest <= squashedMax {
		return 0, false
	}
	// Report the highest foreign version: it is the one an operator can match
	// against the old chain's last migration.
	var highestForeign int64
	for version := range applied {
		if !shippedSet[version] && version > highestForeign {
			highestForeign = version
		}
	}
	return highestForeign, highestForeign != 0
}

// appliedVersions is the set of versions goose_db_version records as applied.
func appliedVersions(ctx context.Context, sqlDB *sql.DB) (map[int64]bool, error) {
	rows, err := sqlDB.QueryContext(ctx, `
		SELECT version_id FROM goose_db_version WHERE is_applied`)
	if err != nil {
		// The run above created and used this table, so a read failure here
		// is a real error rather than an empty database.
		return nil, fmt.Errorf("read goose version: %w", err)
	}
	defer rows.Close()
	applied := map[int64]bool{}
	for rows.Next() {
		var version int64
		if err := rows.Scan(&version); err != nil {
			return nil, fmt.Errorf("read goose version: %w", err)
		}
		applied[version] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read goose version: %w", err)
	}
	return applied, nil
}

// shippedVersions lists every goose version in the embedded directory.
func shippedVersions() ([]int64, error) {
	entries, err := fs.ReadDir(dbschema.Migrations, "migrations")
	if err != nil {
		return nil, fmt.Errorf("read migrations: %w", err)
	}
	versions := make([]int64, 0, len(entries))
	for _, entry := range entries {
		version, err := goose.NumericComponent(entry.Name())
		if err != nil {
			return nil, fmt.Errorf("migration %s: %w", entry.Name(), err)
		}
		versions = append(versions, version)
	}
	return versions, nil
}

func riverUp(ctx context.Context, pool *pgxpool.Pool) error {
	migrator, err := rivermigrate.New(riverpgxv5.New(pool), &rivermigrate.Config{Schema: "public"})
	if err != nil {
		return err
	}
	_, err = migrator.Migrate(ctx, rivermigrate.DirectionUp, nil)
	return err
}
