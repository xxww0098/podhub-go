package app

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/ai"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	"github.com/xxww0098/podhub-go/internal/catalog"
	"github.com/xxww0098/podhub-go/internal/telemetry"
)

const (
	backgroundSweep   = time.Minute
	backgroundPrune   = time.Hour
	backgroundBilling = time.Minute
	backgroundPayment = 15 * time.Minute
	backgroundLogs    = time.Hour
	backgroundCatalog = 30 * time.Second
	reservationAge    = 900 * time.Second
)

// RunBackground starts the API timers. Slice-bucket purge stays in the
// media-gc process and is not started here. Stopping ctx stops the timers.
func RunBackground(ctx context.Context, pool *pgxpool.Pool) {
	if pool == nil {
		return
	}
	sweep := time.NewTicker(backgroundSweep)
	prune := time.NewTicker(backgroundPrune)
	bills := time.NewTicker(backgroundBilling)
	pays := time.NewTicker(backgroundPayment)
	logs := time.NewTicker(backgroundLogs)
	fetch := time.NewTicker(backgroundCatalog)
	defer sweep.Stop()
	defer prune.Stop()
	defer bills.Stop()
	defer pays.Stop()
	defer logs.Stop()
	defer fetch.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-sweep.C:
			if _, err := ai.SweepStranded(ctx, pool); err != nil && ctx.Err() == nil {
				slog.Error("ai reaper", "err", err)
			}
		case <-prune.C:
			if _, err := ai.PruneBodies(ctx, pool); err != nil && ctx.Err() == nil {
				slog.Error("ai body prune", "err", err)
			}
		case <-bills.C:
			// Expiry first: it opens the drain event the projection reads.
			if _, err := billingrepo.ExpireDue(ctx, pool, 200, time.Now()); err != nil && ctx.Err() == nil {
				slog.Error("billing expiry sweep", "err", err)
			}
			if _, err := billingrepo.FinishDrains(ctx, pool, time.Now()); err != nil && ctx.Err() == nil {
				slog.Error("billing drain deadline", "err", err)
			}
			if _, err := billingrepo.ReapExpiredOrders(ctx, pool, time.Now()); err != nil && ctx.Err() == nil {
				slog.Error("billing order reaper", "err", err)
			}
			if _, err := billingrepo.ReapReservations(ctx, pool, reservationAge, 100); err != nil && ctx.Err() == nil {
				slog.Error("billing reservation reaper", "err", err)
			}
		case <-pays.C:
			if _, err := billingrepo.ReconcilePayments(ctx, pool, backgroundPayment); err != nil && ctx.Err() == nil {
				slog.Error("payment reconcile", "err", err)
			}
		case <-logs.C:
			if _, err := telemetry.PruneErrorLogs(ctx, pool, telemetry.DefaultLogRetention); err != nil && ctx.Err() == nil {
				slog.Error("log retention", "err", err)
			}
		case <-fetch.C:
			if _, err := catalog.TickFetch(ctx, pool, time.Now()); err != nil && ctx.Err() == nil {
				slog.Error("catalog fetch schedule", "err", err)
			}
		}
	}
}
