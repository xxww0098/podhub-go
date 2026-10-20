package contract

import "github.com/xxww0098/podhub-go/internal/platform/jobsched"

// Job row types live in platform/jobsched. These aliases keep the contract
// names. Claimed.Lease stays on the original type.
type (
	NewJob  = jobsched.NewJob
	Queued  = jobsched.Queued
	Claimed = jobsched.Claimed
	Lease   = jobsched.Lease
)

const (
	StateSucceeded = jobsched.StateSucceeded
	StateFailed    = jobsched.StateFailed
	StateCancelled = jobsched.StateCancelled
)
