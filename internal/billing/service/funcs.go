package service

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
)

// TopupTx and Redeem are the repo functions the HTTP layer calls.
// internal/billing assigns them in init. service does not import repo.
var (
	TopupTx func(ctx context.Context, tx pgx.Tx, orgID int64, key string, paymentOrderID, amount int64) (contract.WalletRow, error)
	Redeem  func(ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, code, expectedWorkspace string) (domain.RedeemResult, error)
)
