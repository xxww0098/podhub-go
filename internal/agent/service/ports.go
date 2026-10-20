package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	"github.com/xxww0098/podhub-go/internal/agent/domain"
)

// Repository is the store. Reads do not require an org id: the agent tables
// have no RLS, and a user with no workspace is still an agent.
type Repository interface {
	Workbench(ctx context.Context, userID int64) (domain.Workbench, error)
	Ledger(ctx context.Context, userID int64) ([]domain.LedgerView, error)
	Withdrawals(ctx context.Context, userID int64) ([]domain.WithdrawalView, error)
	Claim(ctx context.Context, actor contract.Actor, code string) (string, error)
	SavePayout(ctx context.Context, actor contract.Actor, channel, account, realName *string) (domain.Payout, bool, error)
	Transfer(ctx context.Context, actor contract.Actor, operationID string, amountCents int64) (domain.Transfer, error)
	RequestWithdrawal(ctx context.Context, actor contract.Actor, amountCents int64) (domain.WithdrawalView, error)
}
