// Package billing only links the wallet at init: service and contract.API get
// the repo functions they may not import. The names live under contract,
// domain, repo, service, and http. A binary that calls contract.API (ai) or
// billing/http must import this package, blank if needed.
package billing

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/billing/contract"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	"github.com/xxww0098/podhub-go/internal/billing/service"
)

func init() {
	service.TopupTx = billingrepo.TopupTx
	service.Redeem = billingrepo.Redeem
	service.SubscriptionView = billingrepo.SubscriptionView
	service.Quote = billingrepo.Quote
	service.ConfirmSchedule = billingrepo.ConfirmSchedule
	contract.FulfillSubscriptionOrder = func(ctx context.Context, tx any, publicID string, now time.Time) error {
		order, err := billingrepo.LoadOrder(ctx, tx.(pgx.Tx), publicID)
		if err != nil {
			return err
		}
		return billingrepo.FulfillPaidSubscription(ctx, tx.(pgx.Tx), order, now)
	}
	service.CreateSubscriptionOrder = billingrepo.CreateSubscriptionOrder
	service.CreateTopupOrder = billingrepo.CreateTopupOrder
	service.LoadOrder = billingrepo.LoadOrder
	service.MarkOrderPaid = billingrepo.MarkOrderPaid
	service.MarkOrderReconciled = billingrepo.MarkOrderNeedsReconciliation
	service.FulfillSubscription = billingrepo.FulfillPaidSubscription
	service.ErrNoSubscription = billingrepo.ErrNoSubscription
	contract.API = walletBridge{}
}

// walletBridge forwards to the repo functions. The type assert recovers the
// pgx value the caller passed.
type walletBridge struct{}

func (walletBridge) ViewTx(ctx context.Context, tx any, orgID int64) (contract.WalletView, error) {
	return billingrepo.ViewTx(ctx, tx.(pgx.Tx), orgID)
}

func (walletBridge) RecentLedgerTx(ctx context.Context, tx any, orgID int64, limit int32) ([]contract.LedgerEntryView, error) {
	return billingrepo.RecentLedgerTx(ctx, tx.(pgx.Tx), orgID, limit)
}

func (walletBridge) CurrentAll(ctx context.Context, q any) ([]contract.Price, error) {
	return billingrepo.CurrentAll(ctx, q.(billingrepo.Querier))
}

func (walletBridge) CurrentForModel(ctx context.Context, q any, model string) (contract.Price, bool, error) {
	return billingrepo.CurrentForModel(ctx, q.(billingrepo.Querier), model)
}

func (walletBridge) Publish(ctx context.Context, pool any, actorID int64, request contract.PublishRequest) (contract.Price, error) {
	return billingrepo.Publish(ctx, pool.(*pgxpool.Pool), actorID, request)
}

func (walletBridge) Unpublish(ctx context.Context, pool any, model string) (bool, error) {
	return billingrepo.Unpublish(ctx, pool.(*pgxpool.Pool), model)
}

func (walletBridge) SetOrg(ctx context.Context, tx any, orgID int64) error {
	return billingrepo.SetOrg(ctx, tx.(pgx.Tx), orgID)
}

func (walletBridge) RequireOrg(ctx context.Context, tx any, orgID int64) error {
	return billingrepo.RequireOrg(ctx, tx.(pgx.Tx), orgID)
}

func (walletBridge) HoldTx(ctx context.Context, tx any, orgID int64, key string, ai *int64, amount int64) (contract.WalletRow, error) {
	return billingrepo.HoldTx(ctx, tx.(pgx.Tx), orgID, key, ai, amount)
}

func (walletBridge) ReleaseTx(ctx context.Context, tx any, orgID int64, key string, ai *int64, amount int64, note string) (contract.WalletRow, error) {
	return billingrepo.ReleaseTx(ctx, tx.(pgx.Tx), orgID, key, ai, amount, note)
}

func (walletBridge) SettleTx(ctx context.Context, tx any, orgID int64, key string, ai *int64, held, exact int64) (contract.Settlement, error) {
	return billingrepo.SettleTx(ctx, tx.(pgx.Tx), orgID, key, ai, held, exact)
}
