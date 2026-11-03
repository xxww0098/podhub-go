package domain

// ConfirmEdge is the product branch of admin confirm after the order is loaded.
type ConfirmEdge string

const (
	EdgeSubscription  ConfirmEdge = "subscription"
	EdgeWalletTopup   ConfirmEdge = "wallet_topup"
	EdgePlatformGoods ConfirmEdge = "platform_goods"
	EdgeInvalid       ConfirmEdge = "invalid"
)

// ConfirmProduct matches settle's product switch.
func ConfirmProduct(product string) ConfirmEdge {
	switch product {
	case "subscription":
		return EdgeSubscription
	case "wallet_topup":
		return EdgeWalletTopup
	case "platform_goods":
		return EdgePlatformGoods
	default:
		return EdgeInvalid
	}
}

// CancelEdge is cancel_pending with upstream_closed fixed false.
type CancelEdge string

const (
	CancelApply    CancelEdge = "apply"
	CancelHandled  CancelEdge = "handled"
	CancelUpstream CancelEdge = "upstream"
	CancelMissing  CancelEdge = "missing"
)

// CancelPending decides before the CAS. A missing row is not a status edge.
func CancelPending(found bool, status, provider string) CancelEdge {
	if !found {
		return CancelMissing
	}
	if status != "pending" {
		return CancelHandled
	}
	if provider != "manual" && provider != "unselected" {
		return CancelUpstream
	}
	return CancelApply
}
