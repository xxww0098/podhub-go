package service

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/jobsched"
	"github.com/xxww0098/podhub-go/internal/queue/contract"
	"github.com/xxww0098/podhub-go/internal/queue/domain"
)

// Same-package names for symbols that live in contract or domain, so
// loop.go, work.go, and reconcile.go keep the bodies they had in package queue.
// Repo functions are variables; internal/queue assigns them in init.
// service must not import repo.
type (
	Claimed       = contract.Claimed
	Lease         = contract.Lease
	RequeueReason = domain.RequeueReason
	DueScan       = jobsched.DueScan
)

const (
	AccountLaneQueuedCostLimit = domain.AccountLaneQueuedCostLimit
	ReconcilerAdvisoryLock     = domain.ReconcilerAdvisoryLock
	WakeChannel                = domain.WakeChannel
	WakePollInterval           = domain.WakePollInterval
	LeaseSweepInterval         = domain.LeaseSweepInterval
	HeartbeatInterval          = domain.HeartbeatInterval
	DefaultLeaseSeconds        = domain.DefaultLeaseSeconds
	ReasonSafeToRetry          = domain.ReasonSafeToRetry
	ReasonAdmissionUnavailable = domain.ReasonAdmissionUnavailable
)

// StateSucceeded is jobs.state for a successful body. The repo package owns
// the literal; internal/queue copies it here so service does not import repo.
var StateSucceeded string

var (
	SellerWriteKind = domain.SellerWriteKind
	WorkRequeue     = domain.WorkRequeue
)

var (
	Claim              func(ctx context.Context, pool *pgxpool.Pool, kind, owner string, limit int) ([]Claimed, error)
	FormatOwner        func(role, id string) string
	ReclaimExpiredRows func(ctx context.Context, pool *pgxpool.Pool, kind string) (int, error)
	RunningOwned       func(ctx context.Context, pool *pgxpool.Pool, owner string, kinds []string) (int, error)
	RequeueJob         func(ctx context.Context, pool *pgxpool.Pool, lease Lease, reason RequeueReason, retryAfter time.Duration) (bool, error)
	Settle             func(ctx context.Context, pool *pgxpool.Pool, lease Lease, terminal string, resultRef []byte) (bool, error)
)
