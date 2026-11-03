package contract

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
