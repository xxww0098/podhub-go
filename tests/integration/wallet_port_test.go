package integration

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	adminbillingrepo "github.com/xxww0098/podhub-go/internal/admin/billing/repo"
	"github.com/xxww0098/podhub-go/internal/ai"
	billingcontract "github.com/xxww0098/podhub-go/internal/billing/contract"
	billinghttp "github.com/xxww0098/podhub-go/internal/billing/http"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
)

// aiWalletPort adapts the billing repo functions to the ai wallet port the
// same way internal/app does; the Querier parameters convert implicitly.
func aiWalletPort() ai.Wallet {
	return ai.Wallet{
		ViewTx:         billingrepo.ViewTx,
		RecentLedgerTx: billingrepo.RecentLedgerTx,
		CurrentAll: func(ctx context.Context, q ai.Querier) ([]billingcontract.Price, error) {
			return billingrepo.CurrentAll(ctx, q)
		},
		CurrentForModel: func(ctx context.Context, q ai.Querier, model string) (billingcontract.Price, bool, error) {
			return billingrepo.CurrentForModel(ctx, q, model)
		},
		RequireOrg: billingrepo.RequireOrg,
		HoldTx:     billingrepo.HoldTx,
		ReleaseTx:  billingrepo.ReleaseTx,
		SettleTx:   billingrepo.SettleTx,
	}
}

// entitlementWithBilling wires the manual confirm path the same way
// internal/app does.
func entitlementWithBilling(pool *pgxpool.Pool) *adminbillingrepo.Entitlement {
	ent := adminbillingrepo.NewEntitlement(pool)
	ent.SettleFirstOrderCommission = billingrepo.SettleFirstOrderCommission
	ent.FulfillSubscriptionOrder = func(ctx context.Context, tx pgx.Tx, publicID string, now time.Time) error {
		order, err := billingrepo.LoadOrder(ctx, tx, publicID)
		if err != nil {
			return err
		}
		return billingrepo.FulfillPaidSubscription(ctx, tx, order, now)
	}
	return ent
}

// billingHTTPPort passes the billing repo functions to the HTTP layer the
// same way internal/app does.
func billingHTTPPort() billinghttp.Billing {
	return billinghttp.Billing{
		TopupTx:                 billingrepo.TopupTx,
		Redeem:                  billingrepo.Redeem,
		ConfirmKeep:             billingrepo.ConfirmKeep,
		SubscriptionView:        billingrepo.SubscriptionView,
		Quote:                   billingrepo.Quote,
		CreateSubscriptionOrder: billingrepo.CreateSubscriptionOrder,
		PayAutoOrder:            billingrepo.PayAutoOrder,
		SetAutoRenew:            billingrepo.SetAutoRenew,
		LoadOrder:               billingrepo.LoadOrder,
		MarkOrderPaid:           billingrepo.MarkOrderPaid,
		MarkOrderReconciled:     billingrepo.MarkOrderNeedsReconciliation,
		FulfillSubscription:     billingrepo.FulfillPaidSubscription,
		ErrNoSubscription:       billingrepo.ErrNoSubscription,
	}
}
