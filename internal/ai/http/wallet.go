package aihttp

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
)

// Wallet is the billing ledger port. The signatures match the billing repo
// functions; internal/app passes them. A nil function is an error, never a
// call. billing.Usage, billing.RFC3339Millis and the other DTO names stay
// direct contract references.
type Wallet struct {
	ViewTx          func(ctx context.Context, tx pgx.Tx, orgID int64) (billing.WalletView, error)
	RecentLedgerTx  func(ctx context.Context, tx pgx.Tx, orgID int64, limit int32) ([]billing.LedgerEntryView, error)
	CurrentAll      func(ctx context.Context, q Querier) ([]billing.Price, error)
	CurrentForModel func(ctx context.Context, q Querier, model string) (billing.Price, bool, error)
	RequireOrg      func(ctx context.Context, tx pgx.Tx, orgID int64) error
	HoldTx          func(ctx context.Context, tx pgx.Tx, orgID int64, key string, ai *int64, amount int64) (billing.WalletRow, error)
	ReleaseTx       func(ctx context.Context, tx pgx.Tx, orgID int64, key string, ai *int64, amount int64, note string) (billing.WalletRow, error)
	SettleTx        func(ctx context.Context, tx pgx.Tx, orgID int64, key string, ai *int64, held, exact int64) (billing.Settlement, error)
}

// Querier is the database surface price reads need. Both pgx.Tx and the pool
// satisfy it; the shape matches the billing repo's Querier so the injected
// functions can be thin pass-throughs.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// errWalletNotWired is the refusal for a wallet function that was never
// assembled. It is returned, never panicked on.
var errWalletNotWired = errors.New("wallet port is not wired")
