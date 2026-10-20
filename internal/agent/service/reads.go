package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	"github.com/xxww0098/podhub-go/internal/agent/domain"
)

// Workbench is GET /api/agent.
func (s *Service) Workbench(ctx context.Context, actor contract.Actor) (domain.Workbench, error) {
	if err := authorize(actor); err != nil {
		return domain.Workbench{}, err
	}
	if s.repo == nil {
		return domain.Workbench{}, unavailable()
	}
	view, err := s.repo.Workbench(ctx, actor.UserID)
	if err != nil {
		return domain.Workbench{}, notAgent(err)
	}
	return view, nil
}

// Ledger is GET /api/agent/ledger.
func (s *Service) Ledger(ctx context.Context, actor contract.Actor) ([]domain.LedgerView, error) {
	if err := authorize(actor); err != nil {
		return nil, err
	}
	if s.repo == nil {
		return nil, unavailable()
	}
	rows, err := s.repo.Ledger(ctx, actor.UserID)
	if err != nil {
		return nil, notAgent(err)
	}
	return rows, nil
}

// Withdrawals is GET /api/agent/withdrawals.
func (s *Service) Withdrawals(ctx context.Context, actor contract.Actor) ([]domain.WithdrawalView, error) {
	if err := authorize(actor); err != nil {
		return nil, err
	}
	if s.repo == nil {
		return nil, unavailable()
	}
	rows, err := s.repo.Withdrawals(ctx, actor.UserID)
	if err != nil {
		return nil, notAgent(err)
	}
	return rows, nil
}
