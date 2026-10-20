package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
	"github.com/xxww0098/podhub-go/internal/supplier/domain"
)

// Service reads wallets under the caller's transaction.
// Portal methods delegate to the same value when it implements Portal.
// RequestWithdrawal still refuses to write: that helper is the CHECK-only
// path. HTTP create goes through CreateWithdrawal.
type Service struct {
	port   Port
	portal Portal
}

// New binds a repository. A Portal implementation is picked up when present.
func New(port Port) Service {
	s := Service{port: port}
	if p, ok := port.(Portal); ok {
		s.portal = p
	}
	return s
}

func (s Service) ListWallets(ctx context.Context, orgID, supplierUserID int64) ([]contract.Wallet, error) {
	return s.port.ListWallets(ctx, orgID, supplierUserID)
}

func (s Service) ListWithdrawals(ctx context.Context, orgID, supplierUserID int64) ([]contract.WithdrawalRow, error) {
	return s.port.ListWithdrawals(ctx, orgID, supplierUserID)
}

// RequestWithdrawal validates the CHECK constraints and then refuses to write.
func (s Service) RequestWithdrawal(_ context.Context, cents int64, channel string, openExists bool) error {
	if _, err := domain.Request(cents, channel, openExists); err != nil {
		return err
	}
	return contract.ErrUnproven
}

// Download does not fetch an object.
func (s Service) Download(context.Context) error { return contract.ErrNotPorted }
