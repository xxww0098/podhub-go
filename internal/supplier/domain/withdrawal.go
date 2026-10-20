package domain

import "github.com/xxww0098/podhub-go/internal/supplier/contract"

// Channels are ck_supplier_withdrawals_channel. Comparison is exact;
// the CHECK does not fold case.
func ValidChannel(channel string) bool {
	switch channel {
	case "alipay", "wechat", "bank":
		return true
	default:
		return false
	}
}

// ValidWithdrawalStatus is ck_supplier_withdrawals_status.
func ValidWithdrawalStatus(status string) bool {
	switch status {
	case "requested", "paid", "rejected":
		return true
	default:
		return false
	}
}

// Request is the supplier insert edge: a positive amount, a known channel,
// no other requested row for the source (ux_supplier_withdrawals_one_open),
// and status requested. Microfen is cents * 1000000, and the product must
// fit in bigint the way the CHECK expression does.
func Request(cents int64, channel string, openExists bool) (contract.Withdrawal, error) {
	if cents <= 0 || openExists || !ValidChannel(channel) {
		return contract.Withdrawal{}, contract.ErrInvalid
	}
	if cents > (1<<63-1)/contract.MicrofenPerCent {
		return contract.Withdrawal{}, contract.ErrInvalid
	}
	return contract.Withdrawal{
		AmountCents:    cents,
		AmountMicrofen: cents * contract.MicrofenPerCent,
		Channel:        channel,
		Status:         "requested",
	}, nil
}
