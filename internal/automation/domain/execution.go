package domain

// Execution statuses are automation_executions_status in
// db/migrations/00264_automation_execution_receipts.sql.
const (
	ExecutionRunning     = "running"
	ExecutionCompleted   = "completed"
	ExecutionFailed      = "failed"
	ExecutionCancelled   = "cancelled"
	ExecutionInterrupted = "interrupted"
)

// Execution is the lease shape constrained by automation_executions_lease:
// epoch >= 1, and a running row must carry both a lease token and a deadline.
type Execution struct {
	Status      string
	Epoch       int64
	HasToken    bool
	HasDeadline bool
}

// LeaseOK reports whether the CHECK would accept the row.
func (e Execution) LeaseOK() bool {
	switch e.Status {
	case ExecutionRunning, ExecutionCompleted, ExecutionFailed, ExecutionCancelled, ExecutionInterrupted:
	default:
		return false
	}
	if e.Epoch < 1 {
		return false
	}
	if e.Status != ExecutionRunning {
		return true
	}
	return e.HasToken && e.HasDeadline
}
