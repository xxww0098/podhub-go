package storerepo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/queue/contract"
)

type Queue struct {
	Finish    func(context.Context, *pgxpool.Pool, contract.Lease, string, []byte, string) (bool, error)
	EnqueueOn func(context.Context, pgx.Tx, []contract.NewJob, int64) ([]contract.Queued, error)
	Renew     func(context.Context, *pgxpool.Pool, contract.Lease) (bool, error)
	Requeue   func(context.Context, *pgxpool.Pool, contract.Lease, contract.RequeueReason, time.Duration) (bool, error)
}
