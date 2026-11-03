package billingrepo

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

type PaymentOrders struct{ Pool *pgxpool.Pool }

const checkoutColumns = `id,org_id,created_by_user_id,public_id,COALESCE(operation_id,''),product,provider,currency,status,amount_cents,COALESCE(topup_microfen,0),COALESCE(plan,''),months,qr_code,pay_url,provider_ref,launch_state,created_at,paid_at,canceled_at,payment_deadline_at,purchase_agreement`

func scanCheckout(row pgx.Row) (contract.CheckoutOrder, error) {
	var o contract.CheckoutOrder
	err := row.Scan(&o.ID, &o.OrgID, &o.UserID, &o.PublicID, &o.OperationID, &o.Product, &o.Provider, &o.Currency, &o.Status, &o.AmountCents, &o.TopupMicrofen, &o.Plan, &o.Months, &o.QRCode, &o.PayURL, &o.ProviderRef, &o.LaunchState, &o.CreatedAt, &o.PaidAt, &o.CanceledAt, &o.Deadline, &o.Agreement)
	return o, err
}

func (s PaymentOrders) Get(ctx context.Context, org int64, id string) (contract.CheckoutOrder, error) {
	var out contract.CheckoutOrder
	err := db.InTx(ctx, s.Pool, db.App(org), func(tx pgx.Tx) error {
		var err error
		out, err = scanCheckout(tx.QueryRow(ctx, `SELECT `+checkoutColumns+` FROM payment_orders WHERE org_id=$1 AND public_id=$2`, org, id))
		return err
	})
	return out, err
}

func (s PaymentOrders) List(ctx context.Context, org int64, status string, before int64, limit int) ([]contract.CheckoutOrder, error) {
	out := []contract.CheckoutOrder{}
	err := db.InTx(ctx, s.Pool, db.App(org), func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+checkoutColumns+` FROM payment_orders WHERE org_id=$1 AND ($2='' OR status=$2) AND ($3::bigint=0 OR id<$3) ORDER BY id DESC LIMIT $4`, org, status, before, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			o, err := scanCheckout(rows)
			if err != nil {
				return err
			}
			out = append(out, o)
		}
		return rows.Err()
	})
	return out, err
}

func (s PaymentOrders) CreateTopup(ctx context.Context, org, user int64, workspace, operation, id, provider string, amount int64, now time.Time) (contract.CheckoutOrder, error) {
	if amount < 100 || amount > 9223372036854 {
		return contract.CheckoutOrder{}, &domain.QuoteError{Status: 400, Code: "VALIDATION", Message: "充值金额至少 1 元且不得超出钱包上限"}
	}
	var out contract.CheckoutOrder
	err := db.InTx(ctx, s.Pool, db.App(org), func(tx pgx.Tx) error {
		var actual string
		if err := tx.QueryRow(ctx, `SELECT uuid::text FROM organizations WHERE id=$1 FOR UPDATE`, org).Scan(&actual); err != nil {
			return err
		}
		if !strings.EqualFold(actual, workspace) {
			return &domain.QuoteError{Status: 409, Code: "WORKSPACE_MISMATCH", Message: "工作区已切换，请刷新后重试"}
		}
		prior, err := scanCheckout(tx.QueryRow(ctx, `SELECT `+checkoutColumns+` FROM payment_orders WHERE org_id=$1 AND operation_id=$2`, org, operation))
		if err == nil {
			if prior.Product != "wallet_topup" || prior.Provider != provider || prior.AmountCents != amount || prior.UserID != user {
				return &domain.QuoteError{Status: 409, Code: "CONFLICT", Message: "operation_id 与已提交参数不一致"}
			}
			out = prior
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var pending bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM payment_orders WHERE org_id=$1 AND product='wallet_topup' AND status='pending')`, org).Scan(&pending); err != nil {
			return err
		}
		if pending {
			return &domain.QuoteError{Status: 409, Code: "CONFLICT", Message: "已有待支付的充值订单"}
		}
		out, err = scanCheckout(tx.QueryRow(ctx, `INSERT INTO payment_orders(public_id,org_id,product,months,amount_cents,currency,provider,status,created_by_user_id,created_at,updated_at,topup_microfen,payment_deadline_at,operation_id) VALUES($1,$2,'wallet_topup',1,$3,'CNY',$4,'pending',$5,$6,$6,$7,$8,$9) RETURNING `+checkoutColumns, id, org, amount, provider, user, now, amount*1000000, now.Add(PaymentWindow), operation))
		return err
	})
	return out, err
}

// ClaimEntry commits uncertainty before the first external request. A crashed
// or timed-out attempt is queried by recovery, never silently created again.
func (s PaymentOrders) ClaimEntry(ctx context.Context, org int64, id string) (contract.CheckoutOrder, bool, error) {
	var out contract.CheckoutOrder
	claimed := false
	err := db.InTx(ctx, s.Pool, db.App(org), func(tx pgx.Tx) error {
		var err error
		out, err = scanCheckout(tx.QueryRow(ctx, `SELECT `+checkoutColumns+` FROM payment_orders WHERE org_id=$1 AND public_id=$2 FOR UPDATE`, org, id))
		if err != nil {
			return err
		}
		if out.Status != "pending" || contract.NoChannel(out.Provider) || out.QRCode != nil || out.PayURL != nil || out.LaunchState != nil {
			return nil
		}
		_, err = tx.Exec(ctx, `UPDATE payment_orders SET launch_state='entry_confirming',updated_at=clock_timestamp() WHERE id=$1`, out.ID)
		if err == nil {
			state := "entry_confirming"
			out.LaunchState = &state
			claimed = true
		}
		return err
	})
	return out, claimed, err
}

func (s PaymentOrders) SaveEntry(ctx context.Context, org int64, id string, e contract.PaymentEntry) error {
	return db.InTx(ctx, s.Pool, db.App(org), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE payment_orders SET qr_code=NULLIF($3,''),pay_url=NULLIF($4,''),provider_ref=COALESCE(NULLIF($5,''),provider_ref),launch_state=NULL,updated_at=clock_timestamp() WHERE org_id=$1 AND public_id=$2 AND status='pending'`, org, id, e.QRCode, e.PayURL, e.Reference)
		return err
	})
}

func (s PaymentOrders) Cancel(ctx context.Context, org int64, id string) error {
	return db.InTx(ctx, s.Pool, db.App(org), func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE payment_orders SET status='canceled',canceled_at=clock_timestamp(),qr_code=NULL,pay_url=NULL,launch_state=NULL,updated_at=clock_timestamp() WHERE org_id=$1 AND public_id=$2 AND status='pending'`, org, id)
		if err == nil && tag.RowsAffected() == 0 {
			return &domain.QuoteError{Status: 409, Code: "CONFLICT", Message: "订单已结算"}
		}
		return err
	})
}
