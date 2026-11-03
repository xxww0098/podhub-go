package integration

import (
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	billinghttp "github.com/xxww0098/podhub-go/internal/billing/http"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
)

func TestTopupAmountPaymentAndCreditAgree(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	now := time.Now()
	const credit = int64(100_000_000) // One yuan: 100 fen, each worth 1,000,000 microfen.
	order, err := billingrepo.CreateTopupOrder(ctx, pool, org, user, "po_"+uuid.NewString(), "easypay", credit, now)
	if err != nil {
		t.Fatal(err)
	}
	var cents, microfen int64
	if err := pool.QueryRow(ctx, `SELECT amount_cents,topup_microfen FROM payment_orders WHERE id=$1`, order.ID).Scan(&cents, &microfen); err != nil {
		t.Fatal(err)
	}
	if cents != 100 || microfen != credit {
		t.Errorf("one-yuan top-up persisted charge=%d fen, credit=%d microfen; want 100 fen and %d microfen", cents, microfen, credit)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_wallets(org_id,balance_microfen,held_microfen) VALUES($1,0,0)`, org); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	billinghttp.Register(router, billinghttp.Deps{Billing: billingHTTPPort(), Pool: pool, Now: func() time.Time { return now }, Payments: billinghttp.Payments{EasyPayPID: "1000", EasyPayKey: "synthetic-secret"}})
	for range 2 {
		subscriptionTestCallback(t, router, order.PublicID, 100)
	}
	if got := walletBalance(t, ctx, pool, org); got != credit {
		t.Errorf("one-yuan signed callback credited %d microfen, want %d", got, credit)
	}
	var status string
	var entries int
	if err := pool.QueryRow(ctx, `SELECT status,(SELECT count(*) FROM wallet_ledger WHERE payment_order_id=$1 AND entry_type='topup') FROM payment_orders WHERE id=$1`, order.ID).Scan(&status, &entries); err != nil {
		t.Fatal(err)
	}
	if status != "paid" || entries != 1 {
		t.Errorf("replayed top-up: status=%s ledger entries=%d, want paid and 1", status, entries)
	}
}

func TestTopupAmountRejectsUnpayableCredit(t *testing.T) {
	for _, amount := range []int64{-1, 0, 1_000_000, 99_000_000, 100_000_001, 100_500_000} {
		t.Run(strconv.FormatInt(amount, 10), func(t *testing.T) {
			ctx, pool, org, user := subscriptionTenant(t)
			_, err := billingrepo.CreateTopupOrder(ctx, pool, org, user, "po_"+uuid.NewString(), "easypay", amount, time.Now())
			var validation *domain.QuoteError
			if !errors.As(err, &validation) || validation.Status != 400 || validation.Code != domain.CodeValidation {
				t.Errorf("unpayable credit %d: err=%v, want validation rejection", amount, err)
			}
			var orders int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM payment_orders WHERE org_id=$1`, org).Scan(&orders); err != nil {
				t.Fatal(err)
			}
			if orders != 0 {
				t.Errorf("rejected credit persisted %d orders", orders)
			}
		})
	}
}
