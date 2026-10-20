package domain

import (
	"strings"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
)

const (
	ReconcileIntervalMS = 4 * 60 * 60 * 1000
	ExpiredAfterMS      = 3 * 24 * 60 * 60 * 1000
	FailureExpiresAt    = 3
	ManualRefreshMS     = 10 * 60 * 1000
)

// StoreStatus is the roster status string.
func StoreStatus(manualDisabled, quotaSuspended bool) string {
	if manualDisabled {
		return "manual_disabled"
	}
	if quotaSuspended {
		return "quota_suspended"
	}
	return "active"
}

// StoreFreshness matches store_freshness. A nil sync time is never.
func StoreFreshness(lastFull *int64, failures int, nowMS int64) string {
	if lastFull == nil {
		return "never"
	}
	if failures >= FailureExpiresAt {
		return "expired"
	}
	age := nowMS - *lastFull
	if age < 0 {
		age = 0
	}
	period := int64(ReconcileIntervalMS)
	if age < 2*period && age < ExpiredAfterMS {
		return "fresh"
	}
	if age < ExpiredAfterMS {
		return "stale"
	}
	return "expired"
}

// CountsReadable is fresh or stale with every count present.
func CountsReadable(freshness string, counts []*int64) bool {
	if freshness != "fresh" && freshness != "stale" {
		return false
	}
	for _, count := range counts {
		if count == nil {
			return false
		}
	}
	return true
}

// ManualNext is manual_requested_at_ms plus ten minutes.
func ManualNext(requested *int64) *int64 {
	if requested == nil {
		return nil
	}
	next := *requested + ManualRefreshMS
	return &next
}

// Cursor is store uuid plus a positive product id, at most 57 bytes.
func ParseCursor(raw string, inScope func(string) bool) (store string, product int64, fault *corecontract.Fault) {
	if len(raw) > 57 || !strings.Contains(raw, ":") {
		return "", 0, corecontract.Validation("validation", "cursor 无效")
	}
	storeRaw, productRaw, ok := strings.Cut(raw, ":")
	if !ok {
		return "", 0, corecontract.Validation("validation", "cursor 无效")
	}
	store, ok = corecontract.NormalizeUUID(storeRaw)
	if !ok {
		return "", 0, corecontract.Validation("validation", "cursor 无效")
	}
	var n int64
	for _, c := range productRaw {
		if c < '0' || c > '9' {
			return "", 0, corecontract.Validation("validation", "cursor 无效")
		}
		n = n*10 + int64(c-'0')
	}
	if n <= 0 || productRaw == "" {
		return "", 0, corecontract.Validation("validation", "cursor 无效")
	}
	if inScope != nil && !inScope(store) {
		return "", 0, corecontract.Validation("validation", "cursor 不属于当前范围")
	}
	return store, n, nil
}

// LikeNeedle escapes LIKE metacharacters and lowercases. Blank is no search.
func LikeNeedle(raw string) (string, *corecontract.Fault) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	if len(raw) > 256 {
		return "", corecontract.Validation("validation", "q 最多 256 字节")
	}
	var b strings.Builder
	for _, c := range raw {
		switch c {
		case '\\', '%', '_':
			b.WriteByte('\\')
			b.WriteRune(c)
		default:
			b.WriteRune(c)
		}
	}
	return strings.ToLower(b.String()), nil
}

// ProductLimit defaults to 100 and rejects values outside 1..200.
func ProductLimit(raw *int64) (int64, *corecontract.Fault) {
	if raw == nil {
		return 100, nil
	}
	if *raw < 1 || *raw > 200 {
		return 0, corecontract.Validation("validation", "limit 必须在 1 到 200 之间")
	}
	return *raw, nil
}

// StatusPredicate is the SQL fragment for a product status filter. ok false is an unknown status.
func StatusPredicate(status string) (string, bool) {
	switch status {
	case "":
		return "d.state != 'archived'", true
	case "on_sale":
		return "d.state = 'on_sale'", true
	case "processing":
		return "d.state = 'processing'", true
	case "hidden":
		return "d.state = 'hidden'", true
	case "moderation_failed":
		return "d.state = 'moderation_failed'", true
	case "zero_stock":
		return "d.state = 'on_sale' AND p.stock_present = 0", true
	case "archived":
		return "d.state = 'archived'", true
	case "delisted":
		return "p.gone_at_ms IS NOT NULL", true
	default:
		return "", false
	}
}
