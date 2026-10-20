package domain

import (
	"context"
	"time"
)

// Fail is a telemetry domain error. Status is the HTTP status. Code is the
// SCREAMING_SNAKE wire code. RetryAfter is set only for SQLSTATE 55P03.
type Fail struct {
	Status     int
	Code       string
	Message    string
	RetryAfter string
}

func (f *Fail) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

// Unavailable is a database failure that is not a known SQLSTATE.
func Unavailable() *Fail {
	return &Fail{Status: 500, Code: "INTERNAL", Message: "服务暂不可用"}
}

// WritesDisabled is the telemetry writer lease refusal.
func WritesDisabled() *Fail {
	return &Fail{Status: 503, Code: "WRITES_DISABLED", Message: "遥测域写入未启用"}
}

// LogsNotWritten is a client_listing_logs insert failure.
func LogsNotWritten() *Fail {
	return &Fail{Status: 500, Code: "INTERNAL", Message: "日志没有写入"}
}

// Chunk is one inbox transaction. PreRejected is added to the audit count
// only for the first chunk.
type Chunk struct {
	OrgID       int64
	UserID      int64
	DeviceUID   string
	Events      []AcceptedEvent
	PreRejected int
	S3Limit     int64
	Now         time.Time
}

// ChunkOutcome is one committed chunk. A hard Fail rolls the chunk back.
type ChunkOutcome struct {
	Accepted []string
	Rejected []RejectedEvent
}

// Ingest is the already-decoded inbox batch.
type Ingest struct {
	OrgID     int64
	UserID    int64
	DeviceUID string
	Events    []AcceptedEvent
	Rejected  []RejectedEvent
	Now       time.Time
}

// IngestResult is the HTTP 200 body, before JSON encoding.
type IngestResult struct {
	Accepted []string
	Rejected []RejectedEvent
}

// InboxStore is the persistence port. The repository implements it.
// Inbox tables do not set app.current_org_id. Client logs do.
type InboxStore interface {
	S3MonthlyLimit(ctx context.Context, orgID int64) (int64, error)
	CommitChunk(ctx context.Context, chunk Chunk) (ChunkOutcome, error)
	InsertClientLogs(ctx context.Context, orgID, userID int64, rows []ClientLog) error
}
