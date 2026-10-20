package domain

import (
	"context"
	"encoding/json"
)

// HostError is the MCP host error. Wire keys are code, message, retryable.
type HostError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func (e *HostError) Error() string {
	if e == nil {
		return ""
	}
	return e.Code + ": " + e.Message
}

// NewHost builds a non-retryable host error.
func NewHost(code, message string) *HostError {
	return &HostError{Code: code, Message: message}
}

// Grant is one resolved automation grant. WorkspaceRole is the stored form
// (admin is already manager). SourceAll is a NULL source_ids array.
type Grant struct {
	ID            string
	UserID        int64
	OrgID         int64
	ScopeKind     string
	SourceIDs     []string
	SourceAll     bool
	Actions       []string
	WorkspaceRole string
	PlatformRole  string
}

// Claim is one running execution lease.
type Claim struct {
	GrantID     string
	ExecutionID string
	LeaseToken  string
	LeaseEpoch  int64
}

// Receipt is one visible mutation receipt.
type Receipt struct {
	CallID   string
	Method   string
	Outcome  string
	Metadata json.RawMessage
}

// Envelope is ExecutionEnvelope. A nil Value is omitted. Receipts is never null.
type Envelope struct {
	ExecutionID string
	Status      string
	Value       json.RawMessage
	Error       *HostError
	Calls       int
	Receipts    []Receipt
}

// Start is the claim outcome. Replay carries the recovered envelope.
type Start struct {
	Replay   bool
	Claim    Claim
	Envelope Envelope
}

// Caller is a user session presented to /mcp. It is not an automation grant.
// TokenHash is the session hash the admin standing check already uses.
type Caller struct {
	UserID       int64
	OrgID        int64
	PlatformRole string
	PublicID     string
	TokenHash    string
}

// Store is the MCP persistence port.
type Store interface {
	Resolve(ctx context.Context, tokenHash string) (*Grant, error)
	Begin(ctx context.Context, grant Grant, executionID, digest, version string) (Start, error)
	Finish(ctx context.Context, grant Grant, claim Claim, status string, herr *HostError, calls int) (Envelope, error)
	WorkspaceName(ctx context.Context, grant Grant, claim Claim) (string, error)
	ExecutionView(ctx context.Context, grant Grant, claim Claim, executionID string) (Envelope, error)
}
