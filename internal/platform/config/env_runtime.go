package config

import (
	"os"
	"strconv"
	"strings"
)

// These readers run on every call, not once at Load.

const (
	envAIGlobal        = "CLOUD_AI_MAX_CONCURRENCY_GLOBAL"
	envAIUser          = "CLOUD_AI_MAX_CONCURRENCY_USER"
	envAIAccount       = "CLOUD_AI_MAX_CONCURRENCY_ACCOUNT"
	envAIPerMinute     = "CLOUD_AI_USER_RATE_PER_MINUTE"
	envAILeaseTTL      = "CLOUD_AI_LEASE_TTL_SECONDS"
	envSubmitPrice     = "CLOUD_LISTING_SUBMIT_PRICE_MICROFEN"
	envListingTagsWASM = "LISTING_TAGS_WASM"
	envWASMHostProbe   = "WASM_HOST_PROBE"
	defaultAILeaseSecs = 90
)

// AILimits are the CLOUD_AI_* ceilings. Zero, blank, and invalid values use
// the default: 0 for the ceilings, 90 for the lease TTL even when the env is 0.
type AILimits struct {
	Global          uint32
	User            uint32
	Account         uint32
	PerMinute       uint32
	LeaseTTLSeconds uint32
}

// AILimitsFromEnv reads the five CLOUD_AI_* variables.
func AILimitsFromEnv() AILimits {
	return AILimits{
		Global:          envU32(envAIGlobal, 0),
		User:            envU32(envAIUser, 0),
		Account:         envU32(envAIAccount, 0),
		PerMinute:       envU32(envAIPerMinute, 0),
		LeaseTTLSeconds: envU32(envAILeaseTTL, defaultAILeaseSecs),
	}
}

func envU32(name string, fallback uint32) uint32 {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	n, err := strconv.ParseUint(raw, 10, 32)
	if err != nil || n == 0 {
		return fallback
	}
	return uint32(n)
}

// ListingSubmitPriceMicrofen parses CLOUD_LISTING_SUBMIT_PRICE_MICROFEN.
// Only an integer greater than zero, with space, tab, CR, and LF trimmed, is
// a price. Zero means the work is not sold.
func ListingSubmitPriceMicrofen() int64 {
	raw := trimKey(os.Getenv(envSubmitPrice))
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

// trimKey trims only space, tab, CR, and LF. strings.TrimSpace also drops
// \v, \f, and Unicode spaces, which would accept more values as a price.
func trimKey(key string) string {
	for len(key) > 0 && (key[0] == ' ' || key[0] == '\t' || key[0] == '\n' || key[0] == '\r') {
		key = key[1:]
	}
	for len(key) > 0 && (key[len(key)-1] == ' ' || key[len(key)-1] == '\t' || key[len(key)-1] == '\n' || key[len(key)-1] == '\r') {
		key = key[:len(key)-1]
	}
	return key
}

// ListingTagsWASMPath is LISTING_TAGS_WASM as set, untrimmed. Empty means
// use the embedded module.
func ListingTagsWASMPath() string { return os.Getenv(envListingTagsWASM) }

// WASMHostProbePath is WASM_HOST_PROBE as set, untrimmed. Empty means use
// the embedded probe.
func WASMHostProbePath() string { return os.Getenv(envWASMHostProbe) }
