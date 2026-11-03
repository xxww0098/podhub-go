package app

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

// RunMigrate applies goose and River migrations with the migration login.
//
// This is the one-shot deploy job. It is separate from every server process:
// the API never migrates on startup. PODHUB_ALLOW_SUPERUSER_DB=1 is required
// because the migration login is the postgres owner role.
func RunMigrate(args []string) int {
	fs := flag.NewFlagSet("migrate", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	timeout := fs.Duration("timeout", 10*time.Minute, "overall migration timeout")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	if !config.AllowSuperuserDB() {
		fmt.Fprintln(os.Stderr, "migrate: set PODHUB_ALLOW_SUPERUSER_DB=1 (migration uses the owner role)")
		return 2
	}
	cfg := config.Load()
	if cfg.DatabaseURL == "" {
		fmt.Fprintln(os.Stderr, "migrate: DATABASE_URL is empty")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	pool, err := db.Connect(ctx, cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "migrate: connect: %v\n", err)
		return 1
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		fmt.Fprintf(os.Stderr, "migrate: migrate: %v\n", err)
		return 1
	}
	if password := cfg.APIDBPassword(); password != "" {
		if err := setRolePassword(ctx, pool, "podhub_login_api", password); err != nil {
			fmt.Fprintf(os.Stderr, "migrate: set podhub_login_api password: %v\n", err)
			return 1
		}
	}
	if password := cfg.WorkerDBPassword(); password != "" {
		for _, role := range []string{"podhub_login_listing_worker", "podhub_login_reconciler", "podhub_login_ai_media_worker"} {
			if err := setRolePassword(ctx, pool, role, password); err != nil {
				fmt.Fprintf(os.Stderr, "migrate: set %s password: %v\n", role, err)
				return 1
			}
		}
	}
	fmt.Println("migrate: done")
	return 0
}

// setRolePassword lets the compose deployment create the runtime logins without
// a manual psql step. The password is a SQL literal, so single quotes are
// doubled; standard_conforming_strings leaves backslashes literal.
func setRolePassword(ctx context.Context, pool *pgxpool.Pool, role, password string) error {
	_, err := pool.Exec(ctx, "ALTER ROLE "+role+" PASSWORD '"+strings.ReplaceAll(password, "'", "''")+"'")
	return err
}
