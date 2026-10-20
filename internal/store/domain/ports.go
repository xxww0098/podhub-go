package domain

import "context"

// RosterTx is the transaction handle a roster write closure receives.
//
// The port lives in domain, not in service, because service may not import repo
// and contract may not import domain; domain is the only package both sides can
// name. It carries no implementation.
type RosterTx interface {
	CreateStore(ctx context.Context, orgID int64, actor Actor, input CreateStoreInput) (Row, QuotaChanges, error)
	UpdateStore(ctx context.Context, orgID int64, actor Actor, uuid string, input UpdateStoreInput) (UpdateStoreResult, error)
	SetStatus(ctx context.Context, orgID int64, actor Actor, uuid string, manualDisabled bool, revision int64) (SetStatusResult, error)
	DeleteStore(ctx context.Context, orgID int64, actor Actor, uuid string, revision, nowMS int64) (DeleteStoreResult, error)
	SetAssignee(ctx context.Context, orgID int64, actor Actor, uuid string, assignee *int64, revision int64) (SetAssigneeResult, error)
	CreateGroup(ctx context.Context, orgID int64, actor Actor, name string) (TagView, error)
	RenameGroup(ctx context.Context, orgID int64, actor Actor, uuid, name string) (TagView, error)
	DeleteGroup(ctx context.Context, orgID int64, actor Actor, uuid string) (int64, error)
	ConsumeTombstone(ctx context.Context, orgID, userID int64, uuid string, nowMS int64) (TombstoneResult, error)
	// RegisterCredential stores or rotates one sealed pair and returns what the
	// write produced. The probe already ran; this only writes.
	RegisterCredential(ctx context.Context, orgID int64, actor Actor, uuid, clientID, apiKey string, expectedStoreRevision int64, expectedCredentialRevision *int64, expiresAtMS *int64) (RegisterOutcome, error)
	// DeleteCredential drops the stored ciphertext and advances the generation.
	DeleteCredential(ctx context.Context, orgID int64, actor Actor, uuid string, expectedStoreRevision, expectedCredentialRevision int64) (int64, error)
	// VerifyCredential records one probe's answer against a generation.
	VerifyCredential(ctx context.Context, orgID int64, actor Actor, uuid string, credentialRevision int64, verified bool, failureCode string, expiresAtMS *int64) (VerificationSummary, error)
	// SyncNow decides one 「立即更新」 press inside the write transaction.
	SyncNow(ctx context.Context, orgID int64, uuid string, nowMS int64, syncDisabled bool) (SyncPress, error)
	// ClaimVerify takes the 60 s same-batch claim and the gates. A claim it
	// did not win answers the mirror rows instead of spending a Seller read.
	ClaimVerify(ctx context.Context, orgID int64, uuid, digest string, nowMS int64, syncDisabled bool) (VerifyClaim, error)
	// UpsertProducts lands one Seller detail batch.
	UpsertProducts(ctx context.Context, orgID, storePK int64, uuid string, products []SellerProduct, nowMS int64) error
	// MirrorProducts re-reads the rows a verify just landed.
	MirrorProducts(ctx context.Context, orgID int64, uuid string, offerIDs []string) ([]Product, error)
	// RecordProductIncident writes one pressure signal. Best effort.
	RecordProductIncident(ctx context.Context, orgID int64, uuid, clientID string, status int, nowMS int64)
	// ReleaseVerify undoes this request's own dedup stamp.
	ReleaseVerify(ctx context.Context, orgID int64, uuid, digest string, nowMS int64)
	Record(ctx context.Context, row AuditRow) error
}

// VerifyClaim is what one verify claim decided. Rows is set when the batch was
// claimed inside the repeat window and the mirror can answer without a call.
type VerifyClaim struct {
	Rows               []Product
	Won                bool
	StorePK            int64
	CredentialRevision int64
}

// CreateStoreInput is a normalized create request.
type CreateStoreInput struct {
	Name                 string
	ClientID             *string
	AssigneeMembershipID *int64
}

// UpdateStoreInput carries the "absent vs explicit null" distinction the Client
// ID and group fields need.
type UpdateStoreInput struct {
	Name        *string
	ClientID    *string
	ClientIDSet bool
	KeyManage   *bool
	TagUUIDs    *[]string
	GroupUUID   *string
	Revision    int64
}

// UpdateStoreResult is the view plus the before/after values the audit reports.
// Tag names are an ordered list; the group is a single name that may be absent
// on either side (ungrouped before, or cleared after).
type UpdateStoreResult struct {
	Row        Row
	TagNames   *TagNameChange
	GroupNames *GroupNameChange
}

// TagNameChange is the ordered tag-name set before and after a replacement.
type TagNameChange struct {
	From []string
	To   []string
}

// GroupNameChange is the group name before and after, either side optional.
type GroupNameChange struct {
	From *string
	To   *string
}

// SetStatusResult is the updated row, the reconcile, and the row before it.
type SetStatusResult struct {
	Row     Row
	Changes QuotaChanges
	Before  Row
}

// DeleteStoreResult is the deleted row, its next revision, and the reconcile.
type DeleteStoreResult struct {
	Row      Row
	Revision int64
	Changes  QuotaChanges
}

// SetAssigneeResult is the updated row, the row before it, and whether the
// assignee actually moved.
type SetAssigneeResult struct {
	Row     Row
	Before  Row
	Changed bool
}

// TombstoneResult is the acknowledged store, its revision, and when.
type TombstoneResult struct {
	StoreUUID    string
	Revision     int64
	ConsumedAtMS int64
}

// VerifyResult is the recorded outcome of one credential test.
type VerifyResult struct {
	StoreUUID          string
	CredentialRevision int64
	VerifiedAtMS       int64
}

// AuditRow is one audit_logs entry a write records.
type AuditRow struct {
	Module     string
	EntityType string
	EntityID   string
	Method     string
	Path       string
	Action     string
	Message    any
}
