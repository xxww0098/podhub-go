package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

func (s Service) ListAccounts(ctx context.Context, actor contract.Actor) ([]domain.AccountGroup, error) {
	if s.Store == nil {
		return nil, unavailable(nil)
	}
	rows, err := s.Store.ListAccounts(ctx, actor)
	if err != nil {
		return nil, err
	}
	return domain.GroupAccounts(rows), nil
}

func (s Service) CreateAccount(ctx context.Context, actor contract.Actor, body []byte) (domain.Member, *string, error) {
	in, err := domain.DecodeAccount(body)
	if err != nil {
		return domain.Member{}, nil, err
	}
	if s.Store == nil {
		return domain.Member{}, nil, unavailable(nil)
	}
	password := ""
	if in.Password != nil {
		password = *in.Password
	} else {
		password, err = s.oneTimePassword(true)
		if err != nil {
			return domain.Member{}, nil, err
		}
	}
	publicID, err := s.publicID()
	if err != nil {
		return domain.Member{}, nil, unavailable(err)
	}
	member, initial, err := s.Store.CreateAccount(ctx, actor, in, publicID, s.nowMs(), password)
	return member, initial, fillDisabled(err, msgPortalWrites)
}

func (s Service) PatchAccount(ctx context.Context, actor contract.Actor, memberID string, body []byte) (domain.Member, *string, error) {
	in, _, err := domain.DecodeAccountPatch(body)
	if err != nil {
		return domain.Member{}, nil, err
	}
	id, ok := domain.CanonicalUUID(memberID)
	if !ok {
		return domain.Member{}, nil, &contract.Fail{Kind: contract.KindNotFound, Message: "厂家成员不存在"}
	}
	if s.Store == nil {
		return domain.Member{}, nil, unavailable(nil)
	}
	hash := ""
	if in.Password != nil {
		hash, err = hashPassword(*in.Password)
		if err != nil {
			return domain.Member{}, nil, err
		}
	}
	member, initial, err := s.Store.PatchAccount(ctx, actor, id, in, hash)
	return member, initial, fillDisabled(err, msgPortalWrites)
}

func (s Service) DeleteAccount(ctx context.Context, actor contract.Actor, memberID string) error {
	id, ok := domain.CanonicalUUID(memberID)
	if !ok {
		return &contract.Fail{Kind: contract.KindNotFound, Message: "厂家成员不存在"}
	}
	if s.Store == nil {
		return unavailable(nil)
	}
	return fillDisabled(s.Store.DeleteAccount(ctx, actor, id), msgPortalWrites)
}

func (s Service) AccountStaff(ctx context.Context, userID int64) (bool, bool, error) {
	if s.Store == nil {
		return false, false, unavailable(nil)
	}
	return s.Store.AccountStaff(ctx, userID)
}
