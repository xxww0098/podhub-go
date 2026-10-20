package contract

import (
	"context"
)

// Wallet is the ledger surface ai calls. internal/billing installs the repo
// implementation. Each method is the original function; the tx and pool
// arguments are the same values the callers already passed.
type Wallet interface {
	ViewTx(ctx context.Context, tx any, orgID int64) (WalletView, error)
	RecentLedgerTx(ctx context.Context, tx any, orgID int64, limit int32) ([]LedgerEntryView, error)
	CurrentAll(ctx context.Context, q any) ([]Price, error)
	CurrentForModel(ctx context.Context, q any, model string) (Price, bool, error)
	Publish(ctx context.Context, pool any, actorID int64, request PublishRequest) (Price, error)
	Unpublish(ctx context.Context, pool any, model string) (bool, error)
	SetOrg(ctx context.Context, tx any, orgID int64) error
	RequireOrg(ctx context.Context, tx any, orgID int64) error
	HoldTx(ctx context.Context, tx any, orgID int64, key string, ai *int64, amount int64) (WalletRow, error)
	ReleaseTx(ctx context.Context, tx any, orgID int64, key string, ai *int64, amount int64, note string) (WalletRow, error)
	SettleTx(ctx context.Context, tx any, orgID int64, key string, ai *int64, held, exact int64) (Settlement, error)
}

// API is the installed wallet. It is set from internal/billing before any
// request runs. The package functions below are what ai already calls.
var API Wallet

func ViewTx(ctx context.Context, tx any, orgID int64) (WalletView, error) {
	return API.ViewTx(ctx, tx, orgID)
}

func RecentLedgerTx(ctx context.Context, tx any, orgID int64, limit int32) ([]LedgerEntryView, error) {
	return API.RecentLedgerTx(ctx, tx, orgID, limit)
}

func CurrentAll(ctx context.Context, q any) ([]Price, error) {
	return API.CurrentAll(ctx, q)
}

func CurrentForModel(ctx context.Context, q any, model string) (Price, bool, error) {
	return API.CurrentForModel(ctx, q, model)
}

func Publish(ctx context.Context, pool any, actorID int64, request PublishRequest) (Price, error) {
	return API.Publish(ctx, pool, actorID, request)
}

func Unpublish(ctx context.Context, pool any, model string) (bool, error) {
	return API.Unpublish(ctx, pool, model)
}

func SetOrg(ctx context.Context, tx any, orgID int64) error {
	return API.SetOrg(ctx, tx, orgID)
}

func RequireOrg(ctx context.Context, tx any, orgID int64) error {
	return API.RequireOrg(ctx, tx, orgID)
}

func HoldTx(ctx context.Context, tx any, orgID int64, key string, ai *int64, amount int64) (WalletRow, error) {
	return API.HoldTx(ctx, tx, orgID, key, ai, amount)
}

func ReleaseTx(ctx context.Context, tx any, orgID int64, key string, ai *int64, amount int64, note string) (WalletRow, error) {
	return API.ReleaseTx(ctx, tx, orgID, key, ai, amount, note)
}

func SettleTx(ctx context.Context, tx any, orgID int64, key string, ai *int64, held, exact int64) (Settlement, error) {
	return API.SettleTx(ctx, tx, orgID, key, ai, held, exact)
}
