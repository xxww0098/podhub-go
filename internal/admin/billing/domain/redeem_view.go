package domain

import "time"

// RedeemStatus projects a row. revoked wins, then used, then an expired deadline.
// A deadline that cannot be parsed is not expired; pass a nil expires for that.
func RedeemStatus(revoked, used bool, expires *time.Time, now time.Time) string {
	if revoked {
		return "revoked"
	}
	if used {
		return "redeemed"
	}
	if expires != nil && !expires.After(now) {
		return "expired"
	}
	return "unused"
}

// CodePreview is the list mask. CodeTail is the last four scalars without the mask.
func CodePreview(code string) string {
	return "••••-" + CodeTail(code)
}

func CodeTail(code string) string {
	runes := []rune(code)
	if len(runes) <= 4 {
		return string(runes)
	}
	return string(runes[len(runes)-4:])
}
