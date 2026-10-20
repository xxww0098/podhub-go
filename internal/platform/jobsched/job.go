package jobsched

import (
	"time"

	"github.com/google/uuid"
)

// NewJob is one enqueue input. Lane is the kind. Cost is CostUnits(kind).
type NewJob struct {
	ID              uuid.UUID
	OrgID           int64
	Kind            string
	AggregateType   string
	AggregateID     uuid.UUID
	InputRevision   int64
	IdempotencyKey  string
	Payload         []byte
	SubmitterUserID int64
	MaxAttempts     int32
	Priority        int16
	RunAt           time.Time
	CreatedAt       time.Time
}

// Queued is the jobs row an enqueue returned. Inserted is false when the
// (org, kind, key) triple already existed; the previous payload is kept.
type Queued struct {
	ID       uuid.UUID
	Payload  []byte
	State    string
	Attempt  int32
	Epoch    int64
	Inserted bool
}

// Claimed is a jobs row this call moved to running.
type Claimed struct {
	ID              uuid.UUID
	OrgID           int64
	Kind            string
	SubmitterUserID int64
	Attempt         int32
	MaxAttempts     int32
	Epoch           int64
	Owner           string
	Until           time.Time
	Payload         []byte
}

// Lease is the fence on a running row. Writes carry the epoch the claim
// returned. A stale owner updates zero rows.
type Lease struct {
	ID          uuid.UUID
	Owner       string
	Epoch       int64
	Kind        string
	Attempt     int32
	MaxAttempts int32
	UserID      int64
	Lane        string
}

func (c Claimed) Lease() Lease {
	return Lease{
		ID: c.ID, Owner: c.Owner, Epoch: c.Epoch, Kind: c.Kind,
		Attempt: c.Attempt, MaxAttempts: c.MaxAttempts,
		UserID: c.SubmitterUserID, Lane: c.Kind,
	}
}
