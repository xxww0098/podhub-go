package queuerepo

import (
	"time"

	"github.com/xxww0098/podhub-go/internal/queue/contract"
	"github.com/xxww0098/podhub-go/internal/queue/domain"
)

// Names the kernel file already uses. Aliasing them here keeps every
// function body in kernel.go unqualified after the declarations moved.
type (
	NewJob        = contract.NewJob
	Queued        = contract.Queued
	Claimed       = contract.Claimed
	Lease         = contract.Lease
	RequeueReason = domain.RequeueReason
	LeaseInput    = domain.LeaseInput
	LeaseResult   = domain.LeaseResult
)

const (
	AccountLaneQueuedCostLimit = domain.AccountLaneQueuedCostLimit
	ClaimHeadLimit             = domain.ClaimHeadLimit
	ClaimMaxPerUser            = domain.ClaimMaxPerUser
	DefaultLeaseSeconds        = domain.DefaultLeaseSeconds
	LeaseSweepBatch            = domain.LeaseSweepBatch
	SettleAttempts             = domain.SettleAttempts
	DefaultBusinessPriority    = domain.DefaultBusinessPriority
	DefaultMaxAttempts         = domain.DefaultMaxAttempts
	StateSucceeded             = contract.StateSucceeded
	StateFailed                = contract.StateFailed
	StateCancelled             = contract.StateCancelled
)

func CostUnits(kind string) int32 { return contract.CostUnits(kind) }

func CountsTowardHead(kind, executor string) bool {
	return domain.CountsTowardHead(kind, executor)
}

func PermitClass(kind string) string { return domain.PermitClass(kind) }

func LaneAdmitsLimit(queuedCost int64, kind string, limit int64) bool {
	return domain.LaneAdmitsLimit(queuedCost, kind, limit)
}

func ReclaimExpired(in LeaseInput) LeaseResult { return domain.ReclaimExpired(in) }

func Requeue(attempt, maxAttempts int32, reason RequeueReason) domain.RequeueResult {
	return domain.Requeue(attempt, maxAttempts, reason)
}

func RequeueDelay(kind string, attempt int32, reason RequeueReason, retryAfter time.Duration, seed uint64) time.Duration {
	return domain.RequeueDelay(kind, attempt, reason, retryAfter, seed)
}

func JitterSeed(jobID string, leaseEpoch int64, attempt int32) uint64 {
	return domain.JitterSeed(jobID, leaseEpoch, attempt)
}
