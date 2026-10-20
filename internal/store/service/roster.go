package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// RosterDirectory is the repo side of the roster and its writes. Every method
// opens its own tenant transaction; a write closure must record an audit row or
// the transaction rolls back.
type RosterDirectory interface {
	LoadActor(ctx context.Context, userID, orgID int64) (domain.Actor, *contract.APIError)
	LoadRoster(ctx context.Context, orgID int64, actor domain.Actor) (domain.Roster, *contract.APIError)
	WriteTx(ctx context.Context, orgID, userID int64, disabled string, fn func(context.Context, domain.RosterTx) error) *contract.APIError
}

// WithRoster binds the roster directory.
func (s Service) WithRoster(dir RosterDirectory) Service {
	s.roster = dir
	return s
}

// Roster is GET /api/workspaces/stores. The actor must hold a usable seat.
// The loaded actor comes back too: the view's permissions depend on the
// membership id, which only the directory can resolve.
func (s Service) Roster(ctx context.Context, orgID, userID int64) (domain.Roster, domain.Actor, *contract.APIError) {
	if s.roster == nil {
		return domain.Roster{}, domain.Actor{}, contract.Internal()
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return domain.Roster{}, domain.Actor{}, api
	}
	roster, api := s.roster.LoadRoster(ctx, orgID, actor)
	if api != nil {
		return domain.Roster{}, domain.Actor{}, api
	}
	return roster, actor, nil
}

// CreateStore is POST /api/workspaces/stores. Any usable member may create;
// who the store lands on is AssigneeForCreate's decision.
func (s Service) CreateStore(ctx context.Context, orgID, userID int64, in domain.CreateStoreInput) (domain.Row, domain.QuotaChanges, domain.Actor, *contract.APIError) {
	if s.roster == nil {
		return domain.Row{}, domain.QuotaChanges{}, domain.Actor{}, contract.Internal()
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return domain.Row{}, domain.QuotaChanges{}, domain.Actor{}, api
	}
	var row domain.Row
	var changes domain.QuotaChanges
	api = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesStores, func(ctx context.Context, tx domain.RosterTx) error {
		saved, reconciled, err := tx.CreateStore(ctx, orgID, actor, in)
		if err != nil {
			return err
		}
		row, changes = saved, reconciled
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleStores,
			EntityType: entityStore,
			EntityID:   saved.UUID,
			Method:     "POST",
			Path:       "/api/workspaces/stores",
			Action:     "store_created",
			Message: map[string]any{
				"uuid": saved.UUID, "create_order": saved.CreateOrder, "name": saved.Name,
				"client_id": saved.ClientID, "status": saved.Status(),
				"manual_disabled": saved.ManualDisabled, "quota_suspended": saved.QuotaSuspended,
				"assignee_membership_id": saved.AssigneeMembershipID,
				"assignee_key_manage":    saved.AssigneeKeyManage,
				"revision":               saved.Revision,
				"reconciled":             auditReconcile(reconciled),
			},
		})
	})
	if api != nil {
		return domain.Row{}, domain.QuotaChanges{}, domain.Actor{}, api
	}
	return row, changes, actor, nil
}

// UpdateStore is PUT /api/workspaces/stores/{uuid}.
func (s Service) UpdateStore(ctx context.Context, orgID, userID int64, role, uuid string, in domain.UpdateStoreInput) (domain.Row, domain.Actor, *contract.APIError) {
	if s.roster == nil {
		return domain.Row{}, domain.Actor{}, contract.Internal()
	}
	normalized, ok := domain.NormalizeStoreUUID(uuid)
	if !ok {
		return domain.Row{}, domain.Actor{}, contract.Validation(contract.MsgStoreUUID)
	}
	if in.Name == nil && !in.ClientIDSet && in.KeyManage == nil && in.TagUUIDs == nil && in.GroupUUID == nil {
		return domain.Row{}, domain.Actor{}, contract.Validation(contract.MsgPatchEmpty)
	}
	if in.KeyManage != nil && !isOwnerRole(role) {
		return domain.Row{}, domain.Actor{}, contract.Forbidden(contract.MsgGrantOwnerOnly)
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return domain.Row{}, domain.Actor{}, api
	}
	var row domain.Row
	api = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesStores, func(ctx context.Context, tx domain.RosterTx) error {
		result, err := tx.UpdateStore(ctx, orgID, actor, normalized, in)
		if err != nil {
			return err
		}
		row = result.Row
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleStores,
			EntityType: entityStore,
			EntityID:   result.Row.UUID,
			Method:     "PUT",
			Path:       "/api/workspaces/stores/{uuid}",
			Action:     "store_updated",
			Message: map[string]any{
				"uuid":                   result.Row.UUID,
				"create_order":           result.Row.CreateOrder,
				"assignee_membership_id": result.Row.AssigneeMembershipID,
				"name":                   changeOf(result.Row.Name, result.Row.Name),
				"revision":               map[string]any{"from": in.Revision, "to": result.Row.Revision},
				"tags":                   nullableTagChange(result.TagNames),
				"group":                  nullableGroupChange(result.GroupNames),
			},
		})
	})
	if api != nil {
		return domain.Row{}, domain.Actor{}, api
	}
	return row, actor, nil
}

// SetStatus is POST /api/workspaces/stores/{uuid}/status.
func (s Service) SetStatus(ctx context.Context, orgID, userID int64, role, uuid string, manualDisabled bool, revision int64) (domain.Row, domain.QuotaChanges, domain.Actor, *contract.APIError) {
	if s.roster == nil {
		return domain.Row{}, domain.QuotaChanges{}, domain.Actor{}, contract.Internal()
	}
	if !canManageRole(role) {
		return domain.Row{}, domain.QuotaChanges{}, domain.Actor{}, contract.Forbidden(contract.MsgManagerOnly)
	}
	normalized, ok := domain.NormalizeStoreUUID(uuid)
	if !ok {
		return domain.Row{}, domain.QuotaChanges{}, domain.Actor{}, contract.Validation(contract.MsgStoreUUID)
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return domain.Row{}, domain.QuotaChanges{}, domain.Actor{}, api
	}
	var row domain.Row
	var changes domain.QuotaChanges
	action := "store_restored"
	if manualDisabled {
		action = "store_manually_disabled"
	}
	api = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesStores, func(ctx context.Context, tx domain.RosterTx) error {
		result, err := tx.SetStatus(ctx, orgID, actor, normalized, manualDisabled, revision)
		if err != nil {
			return err
		}
		row, changes = result.Row, result.Changes
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleStores,
			EntityType: entityStore,
			EntityID:   result.Row.UUID,
			Method:     "POST",
			Path:       "/api/workspaces/stores/{uuid}/status",
			Action:     action,
			Message: map[string]any{
				"uuid":                   result.Row.UUID,
				"create_order":           result.Row.CreateOrder,
				"assignee_membership_id": result.Before.AssigneeMembershipID,
				"manual_disabled":        map[string]any{"from": result.Before.ManualDisabled, "to": result.Row.ManualDisabled},
				"quota_suspended":        result.Row.QuotaSuspended,
				"revision":               map[string]any{"from": revision, "to": result.Row.Revision},
				"reconciled":             auditReconcile(result.Changes),
			},
		})
	})
	if api != nil {
		return domain.Row{}, domain.QuotaChanges{}, domain.Actor{}, api
	}
	return row, changes, actor, nil
}

// DeleteStore is DELETE /api/workspaces/stores/{uuid}.
func (s Service) DeleteStore(ctx context.Context, orgID, userID int64, uuid string, revision, nowMS int64) (domain.Row, int64, domain.QuotaChanges, *contract.APIError) {
	if s.roster == nil {
		return domain.Row{}, 0, domain.QuotaChanges{}, contract.Internal()
	}
	normalized, ok := domain.NormalizeStoreUUID(uuid)
	if !ok {
		return domain.Row{}, 0, domain.QuotaChanges{}, contract.Validation(contract.MsgStoreUUID)
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return domain.Row{}, 0, domain.QuotaChanges{}, api
	}
	var row domain.Row
	var next int64
	var changes domain.QuotaChanges
	api = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesStores, func(ctx context.Context, tx domain.RosterTx) error {
		result, err := tx.DeleteStore(ctx, orgID, actor, normalized, revision, nowMS)
		if err != nil {
			return err
		}
		row, next, changes = result.Row, result.Revision, result.Changes
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleStores,
			EntityType: entityStore,
			EntityID:   result.Row.UUID,
			Method:     "DELETE",
			Path:       "/api/workspaces/stores/{uuid}",
			Action:     "store_deleted",
			Message: map[string]any{
				"uuid":                   result.Row.UUID,
				"create_order":           result.Row.CreateOrder,
				"assignee_membership_id": result.Row.AssigneeMembershipID,
				"revision":               map[string]any{"from": revision, "to": result.Revision},
				"reconciled":             auditReconcile(result.Changes),
			},
		})
	})
	if api != nil {
		return domain.Row{}, 0, domain.QuotaChanges{}, api
	}
	return row, next, changes, nil
}

// SetAssignee is POST /api/workspaces/stores/{uuid}/assignee.
func (s Service) SetAssignee(ctx context.Context, orgID, userID int64, role, uuid string, assignee *int64, revision int64) (domain.Row, domain.Actor, *contract.APIError) {
	if s.roster == nil {
		return domain.Row{}, domain.Actor{}, contract.Internal()
	}
	if !canManageRole(role) {
		return domain.Row{}, domain.Actor{}, contract.Forbidden(contract.MsgReassignManager)
	}
	normalized, ok := domain.NormalizeStoreUUID(uuid)
	if !ok {
		return domain.Row{}, domain.Actor{}, contract.Validation(contract.MsgStoreUUID)
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return domain.Row{}, domain.Actor{}, api
	}
	var row domain.Row
	api = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesStores, func(ctx context.Context, tx domain.RosterTx) error {
		result, err := tx.SetAssignee(ctx, orgID, actor, normalized, assignee, revision)
		if err != nil {
			return err
		}
		row = result.Row
		action := "store_assignee_unchanged"
		if result.Changed {
			action = "store_assignee_changed"
		}
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleStores,
			EntityType: entityStore,
			EntityID:   result.Row.UUID,
			Method:     "POST",
			Path:       "/api/workspaces/stores/{uuid}/assignee",
			Action:     action,
			Message: map[string]any{
				"uuid":         result.Row.UUID,
				"create_order": result.Row.CreateOrder,
				"assignee_membership_id": map[string]any{
					"from": result.Before.AssigneeMembershipID, "to": result.Row.AssigneeMembershipID,
				},
				"revision": map[string]any{"from": revision, "to": result.Row.Revision},
			},
		})
	})
	if api != nil {
		return domain.Row{}, domain.Actor{}, api
	}
	return row, actor, nil
}

// ConsumeTombstone is POST /api/workspaces/stores/{uuid}/tombstone-consumed.
func (s Service) ConsumeTombstone(ctx context.Context, orgID, userID int64, uuid string, nowMS int64) (domain.TombstoneResult, *contract.APIError) {
	if s.roster == nil {
		return domain.TombstoneResult{}, contract.Internal()
	}
	normalized, ok := domain.NormalizeStoreUUID(uuid)
	if !ok {
		return domain.TombstoneResult{}, contract.Validation(contract.MsgStoreUUID)
	}
	var out domain.TombstoneResult
	api := s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesTombstone, func(ctx context.Context, tx domain.RosterTx) error {
		result, err := tx.ConsumeTombstone(ctx, orgID, userID, normalized, nowMS)
		if err != nil {
			return err
		}
		out = result
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleTombstone,
			EntityType: entityStore,
			EntityID:   normalized,
			Method:     "POST",
			Path:       "/api/workspaces/stores/{uuid}/tombstone-consumed",
			Action:     "store_tombstone_consumed",
			Message: map[string]any{
				"uuid": normalized, "tombstone_revision": result.Revision,
				"consumed_at_ms": result.ConsumedAtMS,
			},
		})
	})
	if api != nil {
		return domain.TombstoneResult{}, api
	}
	return out, nil
}

// RefreshProductQuotas is POST /api/workspaces/stores/product-quotas/refresh.
// It walks the visible stores whose key can be tested and whose snapshot is
// not fresh, reads Ozon once each, and answers the repainted roster.
func (s Service) RefreshProductQuotas(ctx context.Context, orgID, userID int64) (domain.Roster, domain.Actor, *contract.APIError) {
	return s.refreshSnapshots(ctx, orgID, userID, refreshProducts)
}

// RefreshFinanceBalances is POST
// /api/workspaces/stores/finance-balances/refresh.
func (s Service) RefreshFinanceBalances(ctx context.Context, orgID, userID int64) (domain.Roster, domain.Actor, *contract.APIError) {
	return s.refreshSnapshots(ctx, orgID, userID, refreshFinance)
}

// refreshSnapshots is the shared shape of the two refresh loops: load the
// roster once, spend at most one read per eligible store, then reload. A
// single store's failure never fails the request — the snapshot simply stays
// as it was, which is what "best effort" means here.
func (s Service) refreshSnapshots(ctx context.Context, orgID, userID int64, which refreshKind) (domain.Roster, domain.Actor, *contract.APIError) {
	if s.roster == nil || s.credential == nil || s.products == nil {
		return domain.Roster{}, domain.Actor{}, contract.Internal()
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return domain.Roster{}, domain.Actor{}, api
	}
	roster, api := s.roster.LoadRoster(ctx, orgID, actor)
	if api != nil {
		return domain.Roster{}, domain.Actor{}, api
	}
	nowMS := domain.NowMS()
	for _, row := range roster.Stores {
		if !row.Permissions(actor, nowMS).TestKey {
			continue
		}
		if !snapshotStale(which, row, nowMS) {
			continue
		}
		opened, api := s.credential.OpenCurrentCredential(ctx, orgID, row.UUID)
		if api != nil {
			// An unopenable key is not this loop's failure to report: the
			// roster already says whether a key exists.
			continue
		}
		s.refreshSnapshot(ctx, orgID, row.UUID, opened, nowMS, which)
	}
	reloaded, api := s.roster.LoadRoster(ctx, orgID, actor)
	if api != nil {
		return domain.Roster{}, domain.Actor{}, api
	}
	return reloaded, actor, nil
}

// refreshKind selects which snapshot one loop refills.
type refreshKind int

const (
	refreshProducts refreshKind = iota
	refreshFinance
)

// snapshotStale reports whether the stored snapshot is outside its own window.
// A window that cannot be decoded is stale: an unreadable value has to be
// replaced, not trusted.
func snapshotStale(which refreshKind, row domain.Row, nowMS int64) bool {
	switch which {
	case refreshFinance:
		balance := row.FinanceBalanceView()
		if balance == nil || balance.FetchedAtMS <= 0 {
			return true
		}
		window := int64(financeReadyFreshMS)
		if balance.Outcome == domain.FinanceOutcomeError {
			window = int64(financeErrorFreshMS)
		}
		return nowMS-balance.FetchedAtMS >= window
	default:
		quota := row.ProductQuotaView()
		return quota == nil || quota.FetchedAtMS <= 0 ||
			nowMS-quota.FetchedAtMS >= productQuotaFreshMS
	}
}

// Audit module names. Operators filter the audit log by these, so they are
// contract.
const (
	moduleStores     = "workspace_stores"
	moduleCredential = "store_credential"
	moduleTombstone  = "tombstone_consumption"
	moduleProducts   = "store_products"
	entityStore      = "workspace_store"
	entityProduct    = "store_product"
	entityStoreTag   = "workspace_store_tag"
	entityStoreGroup = "workspace_store_group"
)

// auditReconcile is quota_changes_json: the audit spelling of a reconcile, in
// which the actions read quota_suspended/quota_restored.
func auditReconcile(changes domain.QuotaChanges) map[string]any {
	suspend := make([]map[string]any, 0, len(changes.Suspend))
	for _, change := range changes.Suspend {
		suspend = append(suspend, map[string]any{
			"uuid": change.UUID, "create_order": change.CreateOrder, "action": "quota_suspended",
		})
	}
	restore := make([]map[string]any, 0, len(changes.Restore))
	for _, change := range changes.Restore {
		restore = append(restore, map[string]any{
			"uuid": change.UUID, "create_order": change.CreateOrder, "action": "quota_restored",
		})
	}
	return map[string]any{"suspend": suspend, "restore": restore}
}

func changeOf(from, to string) map[string]any {
	return map[string]any{"from": from, "to": to}
}

func nullableTagChange(change *domain.TagNameChange) any {
	if change == nil {
		return nil
	}
	return map[string]any{"from": change.From, "to": change.To}
}

func nullableGroupChange(change *domain.GroupNameChange) any {
	if change == nil {
		return nil
	}
	return map[string]any{"from": change.From, "to": change.To}
}

func canManageRole(role string) bool { return domain.Actor{Role: role}.CanManageAll() }

func isOwnerRole(role string) bool { return domain.Actor{Role: role}.IsOwner() }
