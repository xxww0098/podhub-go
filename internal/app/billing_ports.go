package app

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/ai"
	billingcontract "github.com/xxww0098/podhub-go/internal/billing/contract"
	billinghttp "github.com/xxww0098/podhub-go/internal/billing/http"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
)

// aiWallet adapts the billing repo functions to the ai wallet port. The
// Querier parameters convert implicitly: both interfaces spell the same two
// methods, and ai must not import the billing repo.
func aiWallet() ai.Wallet {
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

// billingHTTPDeps passes the billing repo functions the HTTP layer calls.
func billingHTTPDeps() billinghttp.Billing {
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
