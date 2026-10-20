package domain

import (
	"strings"
	"unicode/utf8"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
)

// Payout is agents.payout_channel, payout_account, and payout_real_name.
// Empty strings stand for SQL NULL.
type Payout struct {
	Channel  string
	Account  string
	RealName string
}

// Empty reports the all-NULL arm of agents_payout_complete.
func (p Payout) Empty() bool {
	return p.Channel == "" && p.Account == "" && p.RealName == ""
}

// ValidatePayout matches agents_payout_complete and the varchar lengths.
// Values are stored as given. The CHECK applies btrim only to reject blank
// text; it does not rewrite the stored value, so this function does not either.
func ValidatePayout(p Payout) error {
	if p.Empty() {
		return nil
	}
	if p.Channel != "alipay" && p.Channel != "wechat" {
		return contract.ErrInvalidShape
	}
	if strings.TrimSpace(p.Account) == "" || strings.TrimSpace(p.RealName) == "" {
		return contract.ErrInvalidShape
	}
	if len(p.Account) > 128 || len(p.RealName) > 64 || len(p.Channel) > 16 {
		return contract.ErrInvalidShape
	}
	return nil
}

// NormalizePayout is withdrawals.rs normalize_payout_account.
// A nil pointer is JSON null. An empty string is present and still validated.
// clear is the all-null arm. msg is empty on success.
func NormalizePayout(channel, account, realName *string) (payout Payout, clear bool, msg string) {
	if channel == nil && account == nil && realName == nil {
		return Payout{}, true, ""
	}
	if channel == nil || account == nil || realName == nil {
		return Payout{}, false, "收款方式、账号、姓名须同时填写或同时留空"
	}
	ch := strings.ToLower(strings.TrimSpace(*channel))
	acct := strings.TrimSpace(*account)
	name := strings.TrimSpace(*realName)
	if ch != "alipay" && ch != "wechat" {
		return Payout{}, false, "收款渠道仅支持支付宝或微信"
	}
	if n := utf8.RuneCountInString(acct); n < 2 || n > 128 {
		return Payout{}, false, "收款账号需为 2-128 字符"
	}
	if n := utf8.RuneCountInString(name); n < 2 || n > 64 {
		return Payout{}, false, "收款姓名需为 2-64 字符"
	}
	return Payout{Channel: ch, Account: acct, RealName: name}, false, ""
}
