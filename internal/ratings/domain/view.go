package domain

import "time"

// Gate is the workspace visibility row for one store.
type Gate struct {
	Assignee *int64
	MemberID int64
	Role     string
}

// ApplyResult counts history rows and bell events written by one sync.
type ApplyResult struct {
	History int
	Noted   int
}

// Snapshot is the latest stored rating plus the previous history number.
type Snapshot struct {
	Key       string
	Name      string
	ValueType string
	Status    string
	Current   *string
	Past      *string
	Previous  *string
	SyncedAt  time.Time
}

// HistoryRow is one appended change.
type HistoryRow struct {
	ID        int64
	Key       string
	Name      string
	ValueType string
	Status    string
	Current   *string
	Past      *string
	At        time.Time
}

// Due is one store whose lease was taken for this tick.
type Due struct {
	OrgID   int64
	StoreID string
}
