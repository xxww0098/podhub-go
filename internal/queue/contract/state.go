package contract

const (
	// StateSucceeded, StateFailed, and StateCancelled are the terminal
	// jobs.state values listing submit settles. They are not river_job_state.
	StateSucceeded = "succeeded"
	StateFailed    = "failed"
	StateCancelled = "cancelled"
)
