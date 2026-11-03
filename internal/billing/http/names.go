package billinghttp

import (
	"time"

	"github.com/xxww0098/podhub-go/internal/billing/domain"
)

// Same-package names for symbols that moved out of this file, so handler.go
// keeps the body it had in package billing.
type (
	AlipayKey    = domain.AlipayKey
	WechatKey    = domain.WechatKey
	StripeKey    = domain.StripeKey
	AirwallexKey = domain.AirwallexKey
	Notice       = domain.Notice
	RedeemError  = domain.RedeemError
	RedeemResult = domain.RedeemResult
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
