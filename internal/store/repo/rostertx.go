package storerepo

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// rosterTx adapts one pgx transaction to the domain.RosterTx port the service
// layer writes against. Nothing here starts or ends a transaction: the caller
// owns the lease, the audit sink, and the commit.
type rosterTx struct {
	tx     pgx.Tx
	orgID  int64
	userID int64
	// credential is the key-custody half. A rosterTx built without it still
	// answers the roster routes; the credential methods then refuse as a
	// missing writer rather than silently writing an unsealed row.
	credential credentialWriter
}

func (r rosterTx) CreateStore(ctx context.Context, orgID int64, actor domain.Actor, in domain.CreateStoreInput) (domain.Row, domain.QuotaChanges, error) {
	return CreateStore(ctx, r.tx, orgID, actor, CreateInput{
		Name:                 in.Name,
		ClientID:             in.ClientID,
		AssigneeMembershipID: in.AssigneeMembershipID,
	})
}

func (r rosterTx) UpdateStore(ctx context.Context, orgID int64, actor domain.Actor, uuid string, in domain.UpdateStoreInput) (domain.UpdateStoreResult, error) {
	result, err := UpdateStore(ctx, r.tx, orgID, actor, uuid, UpdateInput{
		Name:        in.Name,
		ClientID:    in.ClientID,
		ClientIDSet: in.ClientIDSet,
		KeyManage:   in.KeyManage,
		TagUUIDs:    in.TagUUIDs,
		GroupUUID:   in.GroupUUID,
		Revision:    in.Revision,
	})
	if err != nil {
		return domain.UpdateStoreResult{}, err
	}
	out := domain.UpdateStoreResult{Row: result.Row}
	if result.TagNames != nil {
		out.TagNames = &domain.TagNameChange{From: result.TagNames.From, To: result.TagNames.To}
	}
	if result.GroupNames != nil {
		out.GroupNames = &domain.GroupNameChange{From: result.GroupNames.From, To: result.GroupNames.To}
	}
	return out, nil
}

func (r rosterTx) SetStatus(ctx context.Context, orgID int64, actor domain.Actor, uuid string, manualDisabled bool, revision int64) (domain.SetStatusResult, error) {
	row, changes, before, err := SetStoreStatus(ctx, r.tx, orgID, actor, uuid, manualDisabled, revision)
	if err != nil {
		return domain.SetStatusResult{}, err
	}
	return domain.SetStatusResult{Row: row, Changes: changes, Before: before}, nil
}

func (r rosterTx) DeleteStore(ctx context.Context, orgID int64, actor domain.Actor, uuid string, revision, nowMS int64) (domain.DeleteStoreResult, error) {
	row, next, changes, err := DeleteStore(ctx, r.tx, orgID, actor, uuid, revision, nowMS)
	if err != nil {
		return domain.DeleteStoreResult{}, err
	}
	return domain.DeleteStoreResult{Row: row, Revision: next, Changes: changes}, nil
}

func (r rosterTx) SetAssignee(ctx context.Context, orgID int64, actor domain.Actor, uuid string, assignee *int64, revision int64) (domain.SetAssigneeResult, error) {
	row, before, changed, err := SetAssignee(ctx, r.tx, orgID, actor, uuid, assignee, revision)
	if err != nil {
		return domain.SetAssigneeResult{}, err
	}
	return domain.SetAssigneeResult{Row: row, Before: before, Changed: changed}, nil
}

func (r rosterTx) CreateGroup(ctx context.Context, orgID int64, actor domain.Actor, name string) (domain.TagView, error) {
	if api := requireGroupManager(ctx, r.tx, orgID, actor); api != nil {
		return domain.TagView{}, api
	}
	return CreateGroup(ctx, r.tx, orgID, name)
}

func (r rosterTx) RenameGroup(ctx context.Context, orgID int64, actor domain.Actor, uuid, name string) (domain.TagView, error) {
	if api := requireGroupManager(ctx, r.tx, orgID, actor); api != nil {
		return domain.TagView{}, api
	}
	return RenameGroup(ctx, r.tx, orgID, uuid, name)
}

func (r rosterTx) DeleteGroup(ctx context.Context, orgID int64, actor domain.Actor, uuid string) (int64, error) {
	if api := requireGroupManager(ctx, r.tx, orgID, actor); api != nil {
		return 0, api
	}
	return DeleteGroup(ctx, r.tx, orgID, uuid)
}

func (r rosterTx) ConsumeTombstone(ctx context.Context, orgID, userID int64, uuid string, nowMS int64) (domain.TombstoneResult, error) {
	storeUUID, revision, consumed, err := ConsumeTombstone(ctx, r.tx, orgID, userID, uuid, nowMS)
	if err != nil {
		return domain.TombstoneResult{}, err
	}
	return domain.TombstoneResult{StoreUUID: storeUUID, Revision: revision, ConsumedAtMS: consumed}, nil
}

func (r rosterTx) RegisterCredential(ctx context.Context, orgID int64, actor domain.Actor, uuid, clientID, apiKey string, expectedStoreRevision int64, expectedCredentialRevision *int64, expiresAtMS *int64) (domain.RegisterOutcome, error) {
	return r.credential.RegisterCredential(ctx, r.tx, orgID, actor, uuid, clientID, apiKey, expectedStoreRevision, expectedCredentialRevision, expiresAtMS)
}

func (r rosterTx) DeleteCredential(ctx context.Context, orgID int64, actor domain.Actor, uuid string, expectedStoreRevision, expectedCredentialRevision int64) (int64, error) {
	return r.credential.DeleteCredential(ctx, r.tx, orgID, actor, uuid, expectedStoreRevision, expectedCredentialRevision)
}

func (r rosterTx) VerifyCredential(ctx context.Context, orgID int64, actor domain.Actor, uuid string, credentialRevision int64, verified bool, failureCode string, expiresAtMS *int64) (domain.VerificationSummary, error) {
	return r.credential.VerifyCredential(ctx, r.tx, orgID, actor, uuid, credentialRevision, verified, failureCode, expiresAtMS)
}

func (r rosterTx) Record(ctx context.Context, row domain.AuditRow) error {
	return Record(ctx, Audit{
		Module:     row.Module,
		EntityType: row.EntityType,
		EntityID:   row.EntityID,
		Method:     row.Method,
		Path:       row.Path,
		Action:     row.Action,
		Message:    row.Message,
	})
}

// requireGroupManager locks the Workspace, reloads the actor, and demands a
// manager. The reload is deliberate: a role revoked mid-request must not carry
// the session's stale copy into the write.
func requireGroupManager(ctx context.Context, tx pgx.Tx, orgID int64, actor domain.Actor) *contract.APIError {
	if api := lockWorkspaceRow(ctx, tx, orgID); api != nil {
		return api
	}
	reloaded, api := reloadActorTx(ctx, tx, orgID, actor)
	if api != nil {
		return api
	}
	if !reloaded.CanManageAll() {
		return contract.Forbidden(contract.MsgManagerOnly)
	}
	return nil
}

// credentialKeyID is the ring id stamped on new credential rows.
func (r Repo) credentialKeyID() string {
	if r.keyID != "" {
		return r.keyID
	}
	return seal.DefaultSellerKeyID
}

// WriteTx is write_under_authority with the domain port the service layer uses,
// so the service package never names pgx.
func (r Repo) WriteTx(ctx context.Context, orgID, userID int64, disabled string, fn func(context.Context, domain.RosterTx) error) *contract.APIError {
	return r.writeTx(ctx, orgID, userID, disabled, func(ctx context.Context, tx pgx.Tx) error {
		return fn(ctx, rosterTx{
			tx: tx, orgID: orgID, userID: userID,
			credential: credentialWriter{ring: r.ring, keyID: r.credentialKeyID()},
		})
	})
}

func (r rosterTx) SyncNow(ctx context.Context, orgID int64, uuid string, nowMS int64, syncDisabled bool) (domain.SyncPress, error) {
	return SyncNowTx(ctx, r.tx, orgID, uuid, nowMS, syncDisabled)
}

func (r rosterTx) ClaimVerify(ctx context.Context, orgID int64, uuid, digest string, nowMS int64, syncDisabled bool) (domain.VerifyClaim, error) {
	claim, api := ClaimVerifyTx(ctx, r.tx, orgID, uuid, digest, nowMS, syncDisabled)
	if api != nil {
		return domain.VerifyClaim{}, api
	}
	return domain.VerifyClaim{
		Rows: claim.Rows, Won: claim.Won,
		StorePK: claim.StorePK, CredentialRevision: claim.CredentialRevision,
	}, nil
}

func (r rosterTx) UpsertProducts(ctx context.Context, orgID, storePK int64, uuid string, products []domain.SellerProduct, nowMS int64) error {
	if api := UpsertProductsTx(ctx, r.tx, orgID, storePK, uuid, products, nowMS); api != nil {
		return api
	}
	return nil
}

func (r rosterTx) MirrorProducts(ctx context.Context, orgID int64, uuid string, offerIDs []string) ([]domain.Product, error) {
	rows, api := mirrorProductsTx(ctx, r.tx, orgID, uuid, offerIDs)
	if api != nil {
		return nil, api
	}
	return rows, nil
}

func (r rosterTx) RecordProductIncident(ctx context.Context, orgID int64, uuid, clientID string, status int, nowMS int64) {
	RecordVerifyIncidentTx(ctx, r.tx, orgID, uuid, clientID, status, nowMS)
}

func (r rosterTx) ReleaseVerify(ctx context.Context, orgID int64, uuid, digest string, nowMS int64) {
	ReleaseVerifyTx(ctx, r.tx, orgID, uuid, digest, nowMS)
}
