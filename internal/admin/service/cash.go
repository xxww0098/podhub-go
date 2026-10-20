package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

func (s Service) ListPrompts(ctx context.Context, actor contract.Actor) ([]domain.Prompt, error) {
	if s.Store == nil {
		return nil, unavailable(nil)
	}
	rows, err := s.Store.ListPrompts(ctx, actor)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []domain.Prompt{}
	}
	return rows, nil
}

func (s Service) ListWithdrawals(ctx context.Context, actor contract.Actor, status string) ([]domain.Withdrawal, error) {
	filter, err := domain.NormalizeStatus(status)
	if err != nil {
		return nil, err
	}
	if s.Store == nil {
		return nil, unavailable(nil)
	}
	rows, err := s.Store.ListWithdrawals(ctx, actor, filter)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []domain.Withdrawal{}
	}
	return rows, nil
}

func (s Service) PayWithdrawal(ctx context.Context, actor contract.Actor, id, reference string, nowMs int64) (domain.Withdrawal, error) {
	if s.Store == nil {
		return domain.Withdrawal{}, unavailable(nil)
	}
	row, err := s.Store.PayWithdrawal(ctx, actor, id, reference, nowMs)
	return row, fillDisabled(err, msgPortalWrites)
}

func (s Service) RejectWithdrawal(ctx context.Context, actor contract.Actor, id, reason string, nowMs int64) (domain.Withdrawal, error) {
	if s.Store == nil {
		return domain.Withdrawal{}, unavailable(nil)
	}
	row, err := s.Store.RejectWithdrawal(ctx, actor, id, reason, nowMs)
	return row, fillDisabled(err, msgPortalWrites)
}

func (s Service) ListGrants(ctx context.Context, actor contract.Actor) ([]domain.GrantView, error) {
	if s.Store == nil {
		return nil, unavailable(nil)
	}
	rows, err := s.Store.ListGrants(ctx, actor)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []domain.GrantView{}
	}
	return rows, nil
}

func (s Service) CreateGrant(ctx context.Context, actor contract.Actor, body []byte) (domain.GrantView, string, error) {
	in, err := domain.DecodeGrant(body)
	if err != nil {
		return domain.GrantView{}, "", err
	}
	if s.Store == nil {
		return domain.GrantView{}, "", unavailable(nil)
	}
	return s.Store.CreateGrant(ctx, actor, in)
}

func (s Service) RevokeGrant(ctx context.Context, actor contract.Actor, id string) (string, error) {
	canon, ok := domain.CanonicalUUID(id)
	if !ok {
		return "", &contract.Fail{Kind: contract.KindNotFound, Message: "授权不存在"}
	}
	if s.Store == nil {
		return "", unavailable(nil)
	}
	return s.Store.RevokeGrant(ctx, actor, canon)
}
