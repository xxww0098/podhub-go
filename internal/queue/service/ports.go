package service

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Repository struct {
	Claim              func(context.Context, *pgxpool.Pool, string, string, int) ([]Claimed, error)
	FormatOwner        func(string, string) string
	ReclaimExpiredRows func(context.Context, *pgxpool.Pool, string) (int, error)
	RunningOwned       func(context.Context, *pgxpool.Pool, string, []string) (int, error)
	RequeueJob         func(context.Context, *pgxpool.Pool, Lease, RequeueReason, time.Duration) (bool, error)
}
