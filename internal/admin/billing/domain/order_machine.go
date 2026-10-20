package domain

// ConfirmEdge is the product branch of admin confirm after the order is loaded.
type ConfirmEdge string

const (
	EdgeWalletTopup   ConfirmEdge = "wallet_topup"
	EdgePlatformGoods ConfirmEdge = "platform_goods"
	EdgeMemberSeats   ConfirmEdge = "member_seats"
	EdgeInvalid       ConfirmEdge = "invalid"
)

// ConfirmProduct matches settle's product switch. member_seats requires seats and days.
func ConfirmProduct(product string, memberSeats, durationDays int64) ConfirmEdge {
	switch product {
	case "wallet_topup":
		return EdgeWalletTopup
	case "platform_goods":
		return EdgePlatformGoods
	default:
		if product == "member_seats" && memberSeats >= 1 && durationDays >= 1 {
			return EdgeMemberSeats
		}
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
	if provider != "manual" {
		return CancelUpstream
	}
	return CancelApply
}

// SeatTier is a member-seat plan key the lot CHECK accepts.
func SeatTier(plan string) bool {
	switch plan {
	case "pro", "max", "ultra":
		return true
	default:
		return false
	}
}
