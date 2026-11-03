package app

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// RunLeaseKeeper renews every writer lease on a fixed cadence.
//
// Nothing in the server renews a lease: only a write does. The API and every
// worker therefore depend on this process. Without it a domain becomes
// write-disabled at LeaseTTLMS after the last write.
func RunLeaseKeeper(args []string) int {
	fs := flag.NewFlagSet("lease-keeper", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	once := fs.Bool("once", false, "renew every domain once and exit")
	interval := fs.Duration("interval", 20*time.Second, "renewal cadence (must be below the 60s lease TTL)")
	reason := fs.String("reason", "production lease keeper", "grant reason written on first grant")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	if *interval <= 0 || *interval >= time.Duration(writer.LeaseTTLMS)*time.Millisecond {
		fmt.Fprintln(os.Stderr, "lease-keeper: interval must be positive and below the 60s lease TTL")
		return 2
	}
	cfg := config.Load()
	if cfg.DatabaseURL == "" {
		fmt.Fprintln(os.Stderr, "lease-keeper: DATABASE_URL is empty")
		return 2
	}
	if !cfg.WriterInstancePinned() {
		fmt.Fprintln(os.Stderr, "lease-keeper: CLOUD_INSTANCE_ID must be set to a stable value shared with the API and workers")
		return 2
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "lease-keeper: connect: %v\n", err)
		return 1
	}
	defer pool.Close()
	instance := cfg.WriterInstanceID()
	renew := func() error {
		runCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		return writer.RenewAll(runCtx, pool.Begin, instance, *reason, time.Now().UnixMilli())
	}
	if err := renew(); err != nil {
		if *once {
			fmt.Fprintf(os.Stderr, "lease-keeper: %v\n", err)
			return 1
		}
		log.Printf("lease-keeper: initial renewal: %v", err)
	}
	if *once {
		return 0
	}
	log.Printf("lease-keeper: instance %s renewing %d domains every %s", instance, len(writer.Domains()), *interval)
	ticker := time.NewTicker(*interval)
	defer ticker.Stop()
	for range ticker.C {
		if err := renew(); err != nil {
			log.Printf("lease-keeper: %v", err)
		}
	}
	return 0
}
