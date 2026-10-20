package domain

import "encoding/json"

// AssetItem is one file row in a set view.
type AssetItem struct {
	ID        string
	FileName  string
	SHA256    string
	SizeBytes int64
	RuntimeID *string
}

// AssetSet is the list and create view. Items is never nil after a read.
type AssetSet struct {
	ID          string
	Name        string
	CreatedAtMS int64
	Items       []AssetItem
}

// Claimed is one command returned by claim.
type Claimed struct {
	OperationID     string
	Action          string
	ClientRequestID string
	ClaimEpoch      int64
	Payload         json.RawMessage
	CancelRequested bool
}

// RenewHit is one renew UPDATE. Matched false is control lost.
type RenewHit struct {
	Matched bool
	Cancel  bool
}

// WriteResult is progress or settle. Gone is HTTP 404. Stale is HTTP 200.
type WriteResult struct {
	Applied         bool
	Gone            bool
	CancelRequested bool
}

// GrantView is the list shape. The plaintext token is not on this struct.
type GrantView struct {
	ID           string
	Name         string
	Actions      []string
	TokenPrefix  string
	CreatedAtMS  int64
	ExpiresAtMS  *int64
	LastUsedAtMS *int64
	RevokedAtMS  *int64
}

// RuntimeRow is a runtime before the process-clock live bit is applied.
type RuntimeRow struct {
	ID               string
	GrantID          string
	Label            string
	RendererContract string
	HeartbeatAtMS    int64
	CreatedAtMS      int64
}
