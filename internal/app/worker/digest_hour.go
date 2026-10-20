package worker

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	ozonerrrepo "github.com/xxww0098/podhub-go/internal/ozonerr/repo"
	telemetryrepo "github.com/xxww0098/podhub-go/internal/telemetry/repo"
	telemetrysvc "github.com/xxww0098/podhub-go/internal/telemetry/service"
)

// RunErrorDigestHour is the body of the existing River periodic job
// podhub.error_digest. It blanks Ozon samples older than domain.SampleRetention
// and then projects the previous hour into error_digest. Neither step writes
// jobs.state. A sample-retention error is logged and does not skip the digest.
func RunErrorDigestHour(ctx context.Context, pool *pgxpool.Pool, now time.Time) error {
	if _, err := ozonerrrepo.New(pool).ClearExpiredSamples(ctx, now); err != nil && ctx.Err() == nil {
		slog.Error("ozon sample retention", "err", err)
	}
	_, err := telemetrysvc.AggregateHour(ctx, telemetryrepo.New(pool), now)
	return err
}
