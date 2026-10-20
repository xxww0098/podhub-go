package app

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// BootstrapWriterLease inserts the first live writer_leases row.
// Decide refuses an empty domain, so cutover calls this before either process writes.
// Usage: writer-lease bootstrap <domain>
func BootstrapWriterLease(args []string) int {
	if len(args) != 3 || args[1] != "bootstrap" {
		fmt.Fprintln(os.Stderr, "usage: writer-lease bootstrap <domain>")
		return 2
	}
	cfg := config.Load()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.Connect(ctx, cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer pool.Close()
	id, err := writer.Bootstrap(ctx, pool.Begin, args[2], cfg.WriterInstanceID(), "cutover bootstrap", time.Now().UnixMilli())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Printf("writer lease %d domain %s instance %s\n", id, args[2], cfg.WriterInstanceID())
	return 0
}
