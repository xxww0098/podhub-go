package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

func (s Service) ListFactories(ctx context.Context, actor contract.Actor) ([]domain.Factory, error) {
	if s.Store == nil {
		return nil, unavailable(nil)
	}
	rows, err := s.Store.ListFactories(ctx, actor)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []domain.Factory{}
	}
	if actor.Role != "super_admin" {
		for i := range rows {
			rows[i].Contact, rows[i].InternalNote = "", ""
		}
	}
	return rows, nil
}

func (s Service) CreateFactory(ctx context.Context, actor contract.Actor, body []byte) (domain.Factory, *string, error) {
	in, err := domain.DecodeFactory(body, true)
	if err != nil {
		return domain.Factory{}, nil, err
	}
	if s.Store == nil {
		return domain.Factory{}, nil, unavailable(nil)
	}
	id, err := domain.MintID("fac")
	if err != nil {
		return domain.Factory{}, nil, unavailable(err)
	}
	password, err := s.oneTimePassword(true)
	if err != nil {
		return domain.Factory{}, nil, err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return domain.Factory{}, nil, err
	}
	factory, initial, err := s.Store.CreateFactory(ctx, actor, in, id, s.nowMs(), password, hash)
	return factory, initial, fillDisabled(err, msgPortalWrites)
}

func (s Service) UpdateFactory(ctx context.Context, actor contract.Actor, id string, body []byte) (domain.Factory, error) {
	in, err := domain.DecodeFactory(body, false)
	if err != nil {
		return domain.Factory{}, err
	}
	if s.Store == nil {
		return domain.Factory{}, unavailable(nil)
	}
	factory, err := s.Store.UpdateFactory(ctx, actor, id, in, s.nowMs())
	return factory, fillDisabled(err, msgPortalWrites)
}

func (s Service) DeleteFactory(ctx context.Context, actor contract.Actor, id string) error {
	if s.Store == nil {
		return unavailable(nil)
	}
	return fillDisabled(s.Store.DeleteFactory(ctx, actor, id), msgPortalWrites)
}
