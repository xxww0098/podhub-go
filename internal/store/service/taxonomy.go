package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// CreateGroup is POST /api/workspaces/stores/groups.
func (s Service) CreateGroup(ctx context.Context, orgID, userID int64, role, name string) (domain.TagView, *contract.APIError) {
	if !canManageRole(role) {
		return domain.TagView{}, contract.Forbidden(contract.MsgManagerOnly)
	}
	if s.roster == nil {
		return domain.TagView{}, contract.Internal()
	}
	normalized, api := domain.NormalizeStoreGroupName(name)
	if api != nil {
		return domain.TagView{}, api
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return domain.TagView{}, api
	}
	var view domain.TagView
	api = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesStores, func(ctx context.Context, tx domain.RosterTx) error {
		saved, err := tx.CreateGroup(ctx, orgID, actor, normalized)
		if err != nil {
			return err
		}
		view = saved
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleStores,
			EntityType: entityStoreGroup,
			EntityID:   saved.UUID,
			Method:     "POST",
			Path:       "/api/workspaces/stores/groups",
			Action:     "group_created",
			Message:    map[string]any{"uuid": saved.UUID, "name": saved.Name},
		})
	})
	if api != nil {
		return domain.TagView{}, api
	}
	return view, nil
}

// RenameGroup is PUT /api/workspaces/stores/groups/{uuid}.
func (s Service) RenameGroup(ctx context.Context, orgID, userID int64, role, uuid, name string) (domain.TagView, *contract.APIError) {
	if !canManageRole(role) {
		return domain.TagView{}, contract.Forbidden(contract.MsgManagerOnly)
	}
	if s.roster == nil {
		return domain.TagView{}, contract.Internal()
	}
	normalizedUUID, ok := domain.NormalizeStoreUUID(uuid)
	if !ok {
		return domain.TagView{}, contract.Validation(contract.MsgGroupUUID)
	}
	normalized, api := domain.NormalizeStoreGroupName(name)
	if api != nil {
		return domain.TagView{}, api
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return domain.TagView{}, api
	}
	var view domain.TagView
	api = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesStores, func(ctx context.Context, tx domain.RosterTx) error {
		saved, err := tx.RenameGroup(ctx, orgID, actor, normalizedUUID, normalized)
		if err != nil {
			return err
		}
		view = saved
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleStores,
			EntityType: entityStoreGroup,
			EntityID:   saved.UUID,
			Method:     "PUT",
			Path:       "/api/workspaces/stores/groups/{uuid}",
			Action:     "group_renamed",
			Message:    map[string]any{"uuid": saved.UUID, "name": saved.Name},
		})
	})
	if api != nil {
		return domain.TagView{}, api
	}
	return view, nil
}

// DeleteGroup is DELETE /api/workspaces/stores/groups/{uuid}.
func (s Service) DeleteGroup(ctx context.Context, orgID, userID int64, role, uuid string) (string, *contract.APIError) {
	if !canManageRole(role) {
		return "", contract.Forbidden(contract.MsgManagerOnly)
	}
	if s.roster == nil {
		return "", contract.Internal()
	}
	normalized, ok := domain.NormalizeStoreUUID(uuid)
	if !ok {
		return "", contract.Validation(contract.MsgGroupUUID)
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return "", api
	}
	api = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesStores, func(ctx context.Context, tx domain.RosterTx) error {
		cleared, err := tx.DeleteGroup(ctx, orgID, actor, normalized)
		if err != nil {
			return err
		}
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleStores,
			EntityType: entityStoreGroup,
			EntityID:   normalized,
			Method:     "DELETE",
			Path:       "/api/workspaces/stores/groups/{uuid}",
			Action:     "group_deleted",
			Message:    map[string]any{"uuid": normalized, "stores_cleared": cleared},
		})
	})
	if api != nil {
		return "", api
	}
	return normalized, nil
}
