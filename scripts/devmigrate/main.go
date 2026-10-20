// Command devmigrate applies goose and River migrations to DATABASE_URL.
//
// The API does not migrate on startup and the repository ships no migration
// command. This is that command for local runs only: it is not built into the
// image. It requires PODHUB_ALLOW_SUPERUSER_DB=1 because the migration needs
// the postgres role and the pool otherwise refuses a superuser login.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

func main() {
	if os.Getenv("PODHUB_ALLOW_SUPERUSER_DB") != "1" {
		fmt.Fprintln(os.Stderr, "devmigrate: set PODHUB_ALLOW_SUPERUSER_DB=1 (local only)")
		os.Exit(2)
	}
	cfg := config.Load()
	if cfg.DatabaseURL == "" {
		fmt.Fprintln(os.Stderr, "devmigrate: DATABASE_URL is empty")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool, err := db.Connect(ctx, cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "devmigrate: connect: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		fmt.Fprintf(os.Stderr, "devmigrate: migrate: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("devmigrate: done")
}
