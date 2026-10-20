package service

import (
	"context"
	"time"

	"github.com/xxww0098/podhub-go/internal/telemetry/domain"
)

// DigestStore is the inbox window and the digest write. The service does not
// decide job state, billing, or retention.
type DigestStore interface {
	ErrorWindow(ctx context.Context, start, end time.Time) ([]domain.Observation, error)
	SaveDigest(ctx context.Context, rows []domain.DigestRow) error
}

// AggregateHour projects the previous UTC hour of error-class inbox rows into
// error_digest. The write replaces that window's counts. It does not delete
// inbox rows and does not change any business table.
func AggregateHour(ctx context.Context, store DigestStore, now time.Time) (dropped int, err error) {
	if store == nil {
		return 0, domain.Unavailable()
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	end := now.UTC().Truncate(time.Hour)
	start := end.Add(-time.Hour)
	obs, err := store.ErrorWindow(ctx, start, end)
	if err != nil {
		return 0, err
	}
	rows, dropped := domain.Aggregate(obs, start, end)
	if err := store.SaveDigest(ctx, rows); err != nil {
		return dropped, err
	}
	return dropped, nil
}
