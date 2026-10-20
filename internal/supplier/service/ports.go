package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
)

// Port is the read surface. Withdrawal inserts are not on this port.
type Port interface {
	ListWallets(ctx context.Context, orgID, supplierUserID int64) ([]contract.Wallet, error)
	ListWithdrawals(ctx context.Context, orgID, supplierUserID int64) ([]contract.WithdrawalRow, error)
}
