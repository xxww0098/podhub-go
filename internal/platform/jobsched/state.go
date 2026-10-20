package jobsched

import "errors"

const (
	// StateSucceeded, StateFailed, and StateCancelled are the terminal
	// jobs.state values listing submit settles. They are not river_job_state.
	StateSucceeded = "succeeded"
	StateFailed    = "failed"
	StateCancelled = "cancelled"
)

var (
	// ErrLockBusy is a media_object_leases row this attempt could not lock.
	// The seller receipt, when one exists, is already committed.
	ErrLockBusy = errors.New("could not obtain lock on row in relation media_object_leases")
	// ErrReceiptHeld means external_task_id is committed and a later write
	// failed. The job must be retried without a new seller request and
	// without consuming an attempt.
	ErrReceiptHeld = errors.New("seller receipt is already stored")
	// ErrOrgCap means this organization already has OrgSubmitBatchLimit
	// listing.submit.batch jobs running. Nothing was sent.
	ErrOrgCap = errors.New("organization listing submit batch cap")
)
