package submit

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/queue/contract"
)

type Queue struct {
	EnqueueOn     func(context.Context, pgx.Tx, []contract.NewJob, int64) ([]contract.Queued, error)
	MutateRunning func(context.Context, *pgxpool.Pool, contract.Lease, func(context.Context, pgx.Tx) error) (bool, error)
}

type Service struct{ Queue Queue }
