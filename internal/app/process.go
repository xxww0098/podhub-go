package app

import (
	"context"
	"fmt"
	"os"

	"github.com/xxww0098/podhub-go/internal/app/worker"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/observability"
)

// Main is the API process. It loads config once, then serves until SIGINT.
func Main() int {
	cfg := config.Load()
	shutdown, err := observability.Init("podhub-api", cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "observability: %v\n", err)
		return 1
	}
	defer shutdown(context.Background())
	if err := Serve(context.Background(), cfg); err != nil {
		fmt.Fprintf(os.Stderr, "api: %v\n", err)
		return 1
	}
	return 0
}

// MainListing starts the listing worker. The installer is registered before
// worker.Main loads config, which is the order cmd used to use.
func MainListing() int {
	worker.SetInstaller(Install)
	return worker.Main(worker.RoleListing)
}

// MainSync starts the sync worker.
func MainSync() int {
	worker.SetInstaller(Install)
	return worker.Main(worker.RoleSync)
}

// MainReconcile starts the reconcile worker.
func MainReconcile() int {
	worker.SetInstaller(Install)
	return worker.Main(worker.RoleReconcile)
}

// MainMediaGC starts the slice-bucket cleaner. It does not install scan hooks.
func MainMediaGC() int {
	return worker.Main(worker.RoleMediaGC)
}
