package service

import (
	"github.com/xxww0098/podhub-go/internal/queue/contract"
	"github.com/xxww0098/podhub-go/internal/queue/domain"
)

// Same-package names for symbols that live in contract or domain, so
// loop.go and reconcile.go use the shared job contract and domain rules.
type (
	Claimed       = contract.Claimed
	Lease         = contract.Lease
	RequeueReason = domain.RequeueReason
	DueScan       = contract.DueScan
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
