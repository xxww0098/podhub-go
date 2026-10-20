// Package db opens a loopback pool and applies goose plus River migrations.
package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"

	"github.com/xxww0098/podhub-go/db"
	"github.com/xxww0098/podhub-go/internal/platform/config"
)

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
	// 00330–00332 merged after databases had already applied 00335–00337.
	// Goose refuses a version below the recorded maximum unless this Up
	// applies the gap. Down and every other goose command stay at the default.
	return goose.UpContext(ctx, sqlDB, "migrations", goose.WithAllowMissing())
}

func riverUp(ctx context.Context, pool *pgxpool.Pool) error {
	migrator, err := rivermigrate.New(riverpgxv5.New(pool), &rivermigrate.Config{Schema: "public"})
	if err != nil {
		return err
	}
	_, err = migrator.Migrate(ctx, rivermigrate.DirectionUp, nil)
	return err
}
