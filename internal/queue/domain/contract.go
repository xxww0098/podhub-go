// Package queue's contract is the observable job result.
//
// River runs workers. It does not decide the business row. These functions
// are the Rust results this process is allowed to write: lease reclaim from
// src/listing/kernel/execution/jobs/lease.rs, requeue from settlement.rs, and
// backoff from jobs/backoff.rs at a03d735. Callers must not rename a
// river_job_state into a jobs.state.
package domain

import (
	"errors"
	"math"
	"strconv"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/jobsched"
)

var (
	// ErrLockBusy is a media_object_leases row this attempt could not lock.
	// The seller receipt, when one exists, is already committed.
	ErrLockBusy = jobsched.ErrLockBusy
	// ErrReceiptHeld means external_task_id is committed and a later write
	// failed. The job must be retried without a new seller request and
	// without consuming an attempt.
	ErrReceiptHeld = jobsched.ErrReceiptHeld
	// ErrOrgCap means this organization already has OrgSubmitBatchLimit
	// listing.submit.batch jobs running. Nothing was sent.
	ErrOrgCap = jobsched.ErrOrgCap
)

const (
	// WakeChannel is pg_notify's channel. Payload is jobs.kind.
	// Source: jobs/mod.rs JOB_WAKE_CHANNEL and migration/src/jobs_wake_notify.rs.
	WakeChannel = "ozon_jobs_wake"
	// WakePollInterval is the fallback when NOTIFY is only a hint.
	WakePollInterval = 750 * time.Millisecond

	// DefaultBusinessPriority is jobs.priority's default. river_job.priority
	// only allows 1..4, so this value stays on the business row.
	DefaultBusinessPriority = 100

	AccountLaneQueuedCostLimit int64 = 256
	LaneQueuedCostLimitCeiling int64 = 1024
	ClaimHeadLimit             int64 = 128
	ClaimMaxPerUser            int64 = 2
	DefaultLeaseSeconds        int64 = 30
	DefaultMaxAttempts         int32 = 8
	SettleAttempts             int   = 3

	// LeaseSweepInterval and LeaseSweepBatch match lease.rs: the sweeper
	// runs every second and releases at most 64 expired rows, then calls
	// reap_stale_execution_permits with the same batch size.
	LeaseSweepInterval = time.Second
	LeaseSweepBatch    = 64
	// HeartbeatInterval is LEASE_SECS/3.
	HeartbeatInterval = 10 * time.Second

	// ReconcilerAdvisoryLock is the session lock in reconciler/mod.rs.
	// The hex is the Rust key 0x6f7a6f6e5f72636c. Losing the session
	// releases it.
	ReconcilerAdvisoryLock int64 = 0x6f7a6f6e5f72636c

	ListingInFlightDefault    = 4
	ListingInFlightCap        = 16
	ReconcilerInFlightDefault = 2
	ReconcilerInFlightCap     = 8
	SyncInFlightDefault       = 4
	SyncInFlightCap           = 16
)

// LockOrder is the only legal order before a jobs write:
// account_queue_head for (user, lane), then execution_quota.
// Source: settlement.rs lock_queue_head_then_quota.
func LockOrder() []string {
	return []string{"account_queue_head", "execution_quota"}
}

// BusinessStateFromRiver refuses a rename. River states are not jobs states.
func BusinessStateFromRiver(string) (string, bool) { return "", false }

// LaneAdmits reports whether queued_cost plus this kind still fits the default cap.
func LaneAdmits(queuedCost int64, kind string) bool {
	return LaneAdmitsLimit(queuedCost, kind, AccountLaneQueuedCostLimit)
}

// LaneAdmitsLimit is LaneAdmits with the clamped CLOUD_LANE_QUEUED_COST_LIMIT.
func LaneAdmitsLimit(queuedCost int64, kind string, limit int64) bool {
	if limit <= 0 {
		limit = AccountLaneQueuedCostLimit
	}
	cost := int64(CostUnits(kind))
	return queuedCost >= 0 && cost <= limit && queuedCost <= limit-cost
}

// CountsTowardHead matches refresh_account_queue_head at declaration 269:
// browser media.render and media.upload do not move the counter.
func CountsTowardHead(kind, executor string) bool {
	if executor == "browser" && (kind == "media.render" || kind == "media.upload") {
		return false
	}
	return true
}

// PermitClass is the execution_quota class a worker claim grants.
// ai.recognize and media.upload use the classes named in the quota
// migrations. Every other worker kind uses all_execution. claim.rs was
// not available to re-read; this mapping is the one the quota tests lock.
func PermitClass(kind string) string {
	switch kind {
	case "ai.recognize":
		return "ai_ocr"
	case "media.upload":
		return "cloud_upload"
	default:
		return "all_execution"
	}
}

// SellerWriteKind is a kind whose body would send a Seller write.
// Reads and reconcile probes are not in this set.
func SellerWriteKind(kind string) bool {
	return kind == "listing.submit" || kind == "listing.submit.batch"
}

// ClampLaneLimit applies the 1..1024 clamp from jobs/mod.rs.
func ClampLaneLimit(n int64) int64 {
	if n < 1 {
		return 1
	}
	if n > LaneQueuedCostLimitCeiling {
		return LaneQueuedCostLimitCeiling
	}
	return n
}

// RequeueReason matches settlement.rs. Every reason except SafeToRetry
// withdraws the attempt the claim just counted.
type RequeueReason string

const (
	ReasonStoreBusy            RequeueReason = "store_busy"
	ReasonQuotaExhausted       RequeueReason = "quota_exhausted"
	ReasonRateLimited          RequeueReason = "rate_limited"
	ReasonSafeToRetry          RequeueReason = "safe_to_retry"
	ReasonAdmissionUnavailable RequeueReason = "admission_unavailable"
	ReasonLockBusy             RequeueReason = "lock_busy"
)

func (r RequeueReason) WithdrawAttempt() bool { return r != ReasonSafeToRetry }

// WorkRequeue is the jobs reason for an error returned by listing submit.
// Lock contention and a stored receipt withdraw the attempt the claim
// counted, so the job cannot fail at max_attempts and drop the task id.
// Every other error stays SafeToRetry, which is what the loop used before.
func WorkRequeue(err error) RequeueReason {
	switch {
	case errors.Is(err, ErrLockBusy):
		return ReasonLockBusy
	case errors.Is(err, ErrReceiptHeld), errors.Is(err, ErrOrgCap):
		return ReasonStoreBusy
	default:
		return ReasonSafeToRetry
	}
}

// RequeueResult is the jobs row after requeue_job's UPDATE.
type RequeueResult struct {
	State     string
	Attempt   int32
	ErrorCode string
}

// Requeue matches the UPDATE in settlement.rs requeue_job_on.
// Delay is computed separately by RequeueDelay.
func Requeue(attempt, maxAttempts int32, reason RequeueReason) RequeueResult {
	state := "retry_wait"
	next := attempt
	if reason.WithdrawAttempt() {
		if next > 0 {
			next--
		}
	} else if attempt >= maxAttempts {
		state = "failed"
	}
	return RequeueResult{State: state, Attempt: next, ErrorCode: string(reason)}
}

// LeaseInput is one running job the sweeper might release.
type LeaseInput struct {
	Kind        string
	Executor    string
	Attempt     int32
	MaxAttempts int32
	Intents     int
	LastError   string
}

// LeaseResult is the jobs-row assignment from lease.rs.
// Untouched means reclaim_expired_leases returned before the UPDATE
// (media.render and media.upload).
type LeaseResult struct {
	Untouched  bool
	State      string
	LastError  string
	ClearLease bool
}

// ReclaimExpired is reclaim_expired_leases for one kind: media.render and
// media.upload change no row. Other kinds use the CASE in release_leases.
func ReclaimExpired(in LeaseInput) LeaseResult {
	if in.Kind == "media.render" || in.Kind == "media.upload" {
		return LeaseResult{Untouched: true, State: "running", LastError: in.LastError}
	}
	row := leaseCase(in)
	row.Untouched = false
	return row
}

// LeaseCase is the CASE expression alone. The sweeper does not apply it to
// media.render or media.upload; tests keep the two layers apart.
func LeaseCase(in LeaseInput) LeaseResult { return leaseCase(in) }

func leaseCase(in LeaseInput) LeaseResult {
	uncertain := in.Kind == "ai.recognize" || in.Kind == "media.render" || in.Kind == "media.upload"
	nonBrowserExhausted := in.Executor != "browser" && in.Attempt >= in.MaxAttempts
	state := "retry_wait"
	switch {
	case in.Kind == "listing.submit":
		state = "failed"
	case in.Kind == "listing.submit.batch" && in.Intents > 0:
		state = "failed"
	case uncertain:
		state = "uncertain"
	case nonBrowserExhausted:
		state = "failed"
	}
	errCode := in.LastError
	switch {
	case uncertain:
		errCode = "attempt_uncertain"
	case nonBrowserExhausted:
		errCode = "max_attempts_exhausted"
	}
	return LeaseResult{State: state, LastError: errCode, ClearLease: !uncertain}
}

// RequeueDelay matches jobs/backoff.rs requeue_delay. retryAfter is the
// caller hint. seed is jitter_seed. Durations that do not fit in
// time.Duration saturate at its maximum; Rust's Duration can be larger.
func RequeueDelay(kind string, attempt int32, reason RequeueReason, retryAfter time.Duration, seed uint64) time.Duration {
	base, cap := profile(kind)
	if reason == ReasonRateLimited {
		core := retryAfter
		if core < time.Second {
			core = time.Second
		}
		return saturatingAdd(core, seededJitter(seed, jitterSpan(core)))
	}
	computed := base
	if reason == ReasonSafeToRetry {
		computed = escalated(base, cap, attempt)
	}
	if retryAfter > cap {
		return retryAfter
	}
	core := retryAfter
	if computed > core {
		core = computed
	}
	if core >= cap {
		return cap - seededJitter(seed, jitterSpan(cap/4))
	}
	wait := saturatingAdd(core, seededJitter(seed, jitterSpan(core)))
	if wait > cap {
		return cap
	}
	return wait
}

// JitterSeed matches jobs/backoff.rs jitter_seed (FNV-1a).
func JitterSeed(jobID string, leaseEpoch int64, attempt int32) uint64 {
	hash := uint64(0xcbf29ce484222325)
	for i := 0; i < len(jobID); i++ {
		hash ^= uint64(jobID[i])
		hash *= 0x00000100000001b3
	}
	for _, part := range []string{strconv.FormatInt(leaseEpoch, 10), strconv.FormatInt(int64(attempt), 10)} {
		for i := 0; i < len(part); i++ {
			hash ^= uint64(part[i])
			hash *= 0x00000100000001b3
		}
	}
	return hash
}

func profile(kind string) (base, cap time.Duration) {
	switch kind {
	case "listing.submit", "listing.submit.batch":
		return 2 * time.Second, 900 * time.Second
	case "listing.reconcile":
		return 5 * time.Second, 900 * time.Second
	case "store.product_sync", "delegate.posting_sync":
		return 5 * time.Second, 1800 * time.Second
	default:
		return 5 * time.Second, 300 * time.Second
	}
}

func escalated(base, cap time.Duration, attempt int32) time.Duration {
	rung := int64(attempt) - 1
	if rung < 0 {
		rung = 0
	}
	if rung > 16 {
		rung = 16
	}
	baseMs := base.Milliseconds()
	capMs := cap.Milliseconds()
	escalatedMs := baseMs << rung
	if escalatedMs > capMs || escalatedMs <= 0 {
		escalatedMs = capMs
	}
	return time.Duration(escalatedMs) * time.Millisecond
}

func jitterSpan(core time.Duration) time.Duration {
	span := core / 2
	const floor = 250 * time.Millisecond
	const ceiling = 30 * time.Second
	if span < floor {
		return floor
	}
	if span > ceiling {
		return ceiling
	}
	return span
}

func seededJitter(seed uint64, span time.Duration) time.Duration {
	spanMs := span.Milliseconds()
	if spanMs <= 0 {
		return 0
	}
	return time.Duration(splitmix64(seed)%uint64(spanMs+1)) * time.Millisecond
}

func splitmix64(state uint64) uint64 {
	state += 0x9e3779b97f4a7c15
	mixed := state
	mixed = (mixed ^ (mixed >> 30)) * 0xbf58476d1ce4e5b9
	mixed = (mixed ^ (mixed >> 27)) * 0x94d049bb133111eb
	return mixed ^ (mixed >> 31)
}

func saturatingAdd(a, b time.Duration) time.Duration {
	if b > 0 && a > math.MaxInt64-b {
		return time.Duration(math.MaxInt64)
	}
	return a + b
}

// DeclarationStep is one SeaORM migrator entry. Version is the filename
// stamp, not the goose version. GooseVersion is the declaration index.
type DeclarationStep struct {
	Order        int
	Version      string
	Name         string
	GooseVersion int
}

// InvertedTail is steps 280–282 at a03d735. Two of them share a version stamp.
func InvertedTail() []DeclarationStep {
	return []DeclarationStep{
		{Order: 280, Version: "m20261014_000055", Name: "BannedTags", GooseVersion: 280},
		{Order: 281, Version: "m20261014_000054", Name: "StoreProductVariantFacts", GooseVersion: 281},
		{Order: 282, Version: "m20261014_000055", Name: "SellerResourceOccupancies", GooseVersion: 282},
	}
}
