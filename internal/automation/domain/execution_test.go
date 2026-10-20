package domain

import "testing"

func TestExecutionLeaseCheck(t *testing.T) {
	ok := []Execution{
		{Status: ExecutionRunning, Epoch: 1, HasToken: true, HasDeadline: true},
		{Status: ExecutionCompleted, Epoch: 1},
		{Status: ExecutionFailed, Epoch: 3, HasToken: true},
		{Status: ExecutionCancelled, Epoch: 1},
		{Status: ExecutionInterrupted, Epoch: 9},
	}
	for _, row := range ok {
		if !row.LeaseOK() {
			t.Fatalf("want ok %+v", row)
		}
	}
	bad := []Execution{
		{Status: ExecutionRunning, Epoch: 1},
		{Status: ExecutionRunning, Epoch: 1, HasToken: true},
		{Status: ExecutionRunning, Epoch: 1, HasDeadline: true},
		{Status: ExecutionCompleted, Epoch: 0},
		{Status: "queued", Epoch: 1},
		{Status: ExecutionRunning, Epoch: 0, HasToken: true, HasDeadline: true},
	}
	for _, row := range bad {
		if row.LeaseOK() {
			t.Fatalf("want reject %+v", row)
		}
	}
}
