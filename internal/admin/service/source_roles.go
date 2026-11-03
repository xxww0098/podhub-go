package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// ListFulfillers reads the fulfiller grants of one source.
func (s Service) ListFulfillers(ctx context.Context, actor contract.Actor, sourceID string) ([]domain.Fulfiller, error) {
	if s.Store == nil {
		return nil, unavailable(nil)
	}
	rows, err := s.Store.ListFulfillers(ctx, actor, sourceID)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []domain.Fulfiller{}
	}
	return rows, nil
}

// GrantFulfiller authorizes one supplier account as the source's fulfiller.
// A source holds at most one active fulfiller; the repo turns the unique
// index violation into a conflict.
func (s Service) GrantFulfiller(ctx context.Context, actor contract.Actor, sourceID string, body []byte) (domain.Fulfiller, error) {
	accountUUID, err := domain.DecodeSourceAccountGrant(body)
	if err != nil {
		return domain.Fulfiller{}, err
	}
	if s.Store == nil {
		return domain.Fulfiller{}, unavailable(nil)
	}
	row, err := s.Store.GrantFulfiller(ctx, actor, sourceID, accountUUID, s.nowMs())
	return row, fillDisabled(err, msgDbWrites)
}

// RevokeFulfiller disables one fulfiller grant.
func (s Service) RevokeFulfiller(ctx context.Context, actor contract.Actor, sourceID, fulfillerID string) error {
	id, ok := domain.CanonicalUUID(fulfillerID)
	if !ok {
		return &contract.Fail{Kind: contract.KindNotFound, Message: "履约授权不存在"}
	}
	if s.Store == nil {
		return unavailable(nil)
	}
	return fillDisabled(s.Store.RevokeFulfiller(ctx, actor, sourceID, id, s.nowMs()), msgDbWrites)
}

// ListCatalogManagers reads the catalog-manager grants of one source.
func (s Service) ListCatalogManagers(ctx context.Context, actor contract.Actor, sourceID string) ([]domain.CatalogManager, error) {
	if s.Store == nil {
		return nil, unavailable(nil)
	}
	rows, err := s.Store.ListCatalogManagers(ctx, actor, sourceID)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []domain.CatalogManager{}
	}
	return rows, nil
}

// GrantCatalogManager authorizes one platform account to maintain the
// source's catalog. A source may have several active managers.
func (s Service) GrantCatalogManager(ctx context.Context, actor contract.Actor, sourceID string, body []byte) (domain.CatalogManager, error) {
	accountUUID, err := domain.DecodeSourceAccountGrant(body)
	if err != nil {
		return domain.CatalogManager{}, err
	}
	if s.Store == nil {
		return domain.CatalogManager{}, unavailable(nil)
	}
	row, err := s.Store.GrantCatalogManager(ctx, actor, sourceID, accountUUID, s.nowMs())
	return row, fillDisabled(err, msgDbWrites)
}

// RevokeCatalogManager disables one catalog-manager grant.
func (s Service) RevokeCatalogManager(ctx context.Context, actor contract.Actor, sourceID, managerID string) error {
	id, ok := domain.CanonicalUUID(managerID)
	if !ok {
		return &contract.Fail{Kind: contract.KindNotFound, Message: "商品负责人授权不存在"}
	}
	if s.Store == nil {
		return unavailable(nil)
	}
	return fillDisabled(s.Store.RevokeCatalogManager(ctx, actor, sourceID, id, s.nowMs()), msgDbWrites)
}
