package readhttp

import (
	"context"
	"github.com/jackc/pgx/v5"
	queue "github.com/xxww0098/podhub-go/internal/queue/contract"
)

// MediaQueue writes durable browser work in the row's transaction.
type MediaQueue struct {
	EnqueueOn func(context.Context, pgx.Tx, []queue.NewJob, int64) ([]queue.Queued, error)
}

// TransitStorage contains only current storage identity and public addressing.
// Storage credentials and byte verification remain in the media domain.
type TransitStorage struct {
	AccountID       string
	StorageRevision int64
	PublicURL       func(string) string
}
