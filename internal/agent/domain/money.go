package domain

import "math"

// MicrofenPerFen is wallet::MICROFEN_PER_FEN. One 分 credits this many microfen.
const MicrofenPerFen int64 = 1_000_000

// LedgerWindow is the SQL LIMIT passed to recent_ledger before the Go filter.
const LedgerWindow int64 = 200

// CommissionWindow is the workbench commission list limit.
const CommissionWindow int64 = 200

// WithdrawalWindow is the withdrawal list limit.
const WithdrawalWindow int64 = 200

// ReviewThreshold is ATTRIBUTION_REVIEW_THRESHOLD. The flag fires when the
// count of attributions in the last 24 hours is strictly greater than this.
const ReviewThreshold int64 = 20

// AuthGateKey is AUTH_MAINTENANCE_GATE_KEY, shared advisory lock for auth writes.
const AuthGateKey int64 = 0x6f7a6f6e5f617574

// BodyLimitBytes is REQUEST_BODY_LIMIT_BYTES. Handlers that read JSON map a
// larger body to the same 400 as any other JsonRejection.
const BodyLimitBytes int64 = 2 * 1024 * 1024

// Microfen multiplies cents by MicrofenPerFen. ok is false on overflow,
// which the transfer route reports as 409 转入金额超出可表示范围.
func Microfen(cents int64) (int64, bool) {
	if cents > math.MaxInt64/MicrofenPerFen || cents < math.MinInt64/MicrofenPerFen {
		return 0, false
	}
	return cents * MicrofenPerFen, true
}

// SaturatingSub is i64::saturating_sub, used by the commission wallet's
// available_cents. The workbench response subtracts without saturating.
func SaturatingSub(a, b int64) int64 {
	if b > 0 {
		if a < math.MinInt64+b {
			return math.MinInt64
		}
	} else if b < 0 {
		if a > math.MaxInt64+b {
			return math.MaxInt64
		}
	}
	return a - b
}

// AgentLedgerVisible is the GET /api/agent/ledger filter applied after LIMIT.
func AgentLedgerVisible(entryType string) bool {
	return entryType == "commission" || entryType == "transfer_out"
}
