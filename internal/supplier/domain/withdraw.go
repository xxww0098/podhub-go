package domain

import (
	"strings"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
)

const (
	minWithdrawalCents int64 = 100
	maxWithdrawalCents int64 = 100_000_000
)

// WithdrawalInput is the checked POST body. Channel is the trimmed token.
type WithdrawalInput struct {
	SourceID       string
	AmountCents    int64
	AmountMicrofen int64
	Channel        string
	Account        string
	RealName       string
}

// CheckWithdrawal applies the handler checks in source order.
// sourceID is not trimmed. account and realName lengths are counted after trim.
func CheckWithdrawal(sourceID string, cents int64, channel, account, realName string) (WithdrawalInput, error) {
	account = strings.TrimSpace(account)
	realName = strings.TrimSpace(realName)
	channel = strings.TrimSpace(channel)
	if n := RuneLen(account); n < 1 || n > 64 {
		return WithdrawalInput{}, contract.Fail(400, "validation", "收款账号须为 1–64 个字符")
	}
	if n := RuneLen(realName); n < 1 || n > 32 {
		return WithdrawalInput{}, contract.Fail(400, "validation", "收款人须为 1–32 个字符")
	}
	if !ValidChannel(channel) {
		return WithdrawalInput{}, contract.Fail(400, "validation", "提现渠道无效")
	}
	if cents < minWithdrawalCents {
		return WithdrawalInput{}, contract.Fail(400, "validation", "提现金额不能少于 1 元")
	}
	if cents > maxWithdrawalCents {
		return WithdrawalInput{}, contract.Fail(400, "validation", "单笔提现超出上限")
	}
	if cents > (1<<63-1)/contract.MicrofenPerCent {
		return WithdrawalInput{}, contract.Fail(409, "conflict", "结算金额超出范围")
	}
	return WithdrawalInput{
		SourceID:       sourceID,
		AmountCents:    cents,
		AmountMicrofen: cents * contract.MicrofenPerCent,
		Channel:        channel,
		Account:        account,
		RealName:       realName,
	}, nil
}
