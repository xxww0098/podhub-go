package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	"github.com/xxww0098/podhub-go/internal/agent/domain"
)

// Claim is POST /api/agent/claim. Shape checks run inside the write gate.
func (s *Service) Claim(ctx context.Context, actor contract.Actor, code string) (string, error) {
	if err := authorize(actor); err != nil {
		return "", err
	}
	if s.repo == nil {
		return "", unavailable()
	}
	return s.repo.Claim(ctx, actor, code)
}

// SavePayout is PUT /api/agent/payout-account.
// The bool is true when the account was cleared.
func (s *Service) SavePayout(ctx context.Context, actor contract.Actor, channel, account, realName *string) (domain.Payout, bool, error) {
	if err := authorize(actor); err != nil {
		return domain.Payout{}, false, err
	}
	if s.repo == nil {
		return domain.Payout{}, false, unavailable()
	}
	return s.repo.SavePayout(ctx, actor, channel, account, realName)
}

// Transfer is POST /api/agent/wallet-transfers.
func (s *Service) Transfer(ctx context.Context, actor contract.Actor, operationID string, amountCents int64) (domain.Transfer, error) {
	if err := authorize(actor); err != nil {
		return domain.Transfer{}, err
	}
	if s.repo == nil {
		return domain.Transfer{}, unavailable()
	}
	return s.repo.Transfer(ctx, actor, operationID, amountCents)
}

// RequestWithdrawal is POST /api/agent/withdrawals.
func (s *Service) RequestWithdrawal(ctx context.Context, actor contract.Actor, amountCents int64) (domain.WithdrawalView, error) {
	if err := authorize(actor); err != nil {
		return domain.WithdrawalView{}, err
	}
	if s.repo == nil {
		return domain.WithdrawalView{}, unavailable()
	}
	return s.repo.RequestWithdrawal(ctx, actor, amountCents)
}
