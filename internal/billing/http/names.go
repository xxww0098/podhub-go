package billinghttp

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	"github.com/xxww0098/podhub-go/internal/billing/service"
)

// Same-package names for symbols that moved out of this file, so handler.go
// keeps the body it had in package billing.
type (
	AlipayKey    = domain.AlipayKey
	WechatKey    = domain.WechatKey
	StripeKey    = domain.StripeKey
	Notice       = domain.Notice
	RedeemError  = domain.RedeemError
	RedeemResult = domain.RedeemResult
	WalletRow    = contract.WalletRow
)

func VerifyAlipay(key AlipayKey, values map[string]string, now time.Time) (Notice, error) {
	return domain.VerifyAlipay(key, values, now)
}

func VerifyWechat(key WechatKey, header map[string]string, body []byte, now time.Time) (Notice, error) {
	return domain.VerifyWechat(key, header, body, now)
}

func VerifyStripe(key StripeKey, header string, body []byte, now time.Time) (Notice, error) {
	return domain.VerifyStripe(key, header, body, now)
}

func VerifyEasyPay(pid, merchantKey string, values map[string]string, now time.Time) (Notice, error) {
	return domain.VerifyEasyPay(pid, merchantKey, values, now)
}

func FormValues(body []byte) map[string]string { return domain.FormValues(body) }

func RFC3339Millis(t time.Time) string { return contract.RFC3339Millis(t) }

func TopupTx(ctx context.Context, tx pgx.Tx, orgID int64, key string, paymentOrderID, amount int64) (WalletRow, error) {
	return service.TopupTx(ctx, tx, orgID, key, paymentOrderID, amount)
}

func Redeem(ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, code, expectedWorkspace string) (RedeemResult, error) {
	return service.Redeem(ctx, pool, orgID, userID, code, expectedWorkspace)
}
