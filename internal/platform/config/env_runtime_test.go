package config

import (
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// runtimeEnv is one environment state. set=false unsets the variable.
type runtimeEnv struct {
	name  string
	value string
	set   bool
}

func setRuntimeEnv(t *testing.T, key string, c runtimeEnv) {
	t.Helper()
	if c.set {
		t.Setenv(key, c.value)
		return
	}
	t.Setenv(key, "")
	os.Unsetenv(key)
}

var numericEnv = []runtimeEnv{
	{name: "unset"},
	{name: "empty", value: "", set: true},
	{name: "blank", value: "   ", set: true},
	{name: "zero", value: "0", set: true},
	{name: "one", value: "1", set: true},
	{name: "padded", value: " 42 ", set: true},
	{name: "tab lf", value: "\t42\n", set: true},
	{name: "cr", value: "\r42\r", set: true},
	{name: "vtab", value: "\v42", set: true},
	{name: "formfeed", value: "42\f", set: true},
	{name: "nbsp", value: "\u00a042", set: true},
	{name: "negative", value: "-5", set: true},
	{name: "plus", value: "+5", set: true},
	{name: "leading zero", value: "007", set: true},
	{name: "decimal", value: "1.5", set: true},
	{name: "hex", value: "0x10", set: true},
	{name: "word", value: "ten", set: true},
	{name: "inner space", value: "1 0", set: true},
	{name: "u32 max", value: "4294967295", set: true},
	{name: "u32 overflow", value: "4294967296", set: true},
	{name: "i64 max", value: "9223372036854775807", set: true},
	{name: "i64 overflow", value: "9223372036854775808", set: true},
	{name: "invalid utf8", value: "\xff", set: true},
}

var pathEnv = []runtimeEnv{
	{name: "unset"},
	{name: "empty", value: "", set: true},
	{name: "blank", value: "  ", set: true},
	{name: "relative", value: "wasm/dist/server/listing-tags.wasm", set: true},
	{name: "absolute", value: "/tmp/x.wasm", set: true},
	{name: "padded", value: " wasm/dist/test/host-probe.wasm ", set: true},
}

// The legacy* functions are the bodies removed from ai/service/pace.go,
// billing/repo/operations.go (with billing's trimKey), and the os.Getenv
// line of engine.readEnvFile, copied byte for byte.

type legacyLimits struct {
	Global    uint32
	User      uint32
	Account   uint32
	PerMinute uint32
	LeaseTTL  time.Duration
}

func legacyLimitsFromEnv() legacyLimits {
	return legacyLimits{
		Global:    legacyEnvU32("CLOUD_AI_MAX_CONCURRENCY_GLOBAL", 0),
		User:      legacyEnvU32("CLOUD_AI_MAX_CONCURRENCY_USER", 0),
		Account:   legacyEnvU32("CLOUD_AI_MAX_CONCURRENCY_ACCOUNT", 0),
		PerMinute: legacyEnvU32("CLOUD_AI_USER_RATE_PER_MINUTE", 0),
		LeaseTTL:  time.Duration(legacyEnvU32("CLOUD_AI_LEASE_TTL_SECONDS", 90)) * time.Second,
	}
}

func legacyEnvU32(name string, fallback uint32) uint32 {
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

func legacyListingSubmitPriceMicrofen() int64 {
	raw := legacyTrimKey(os.Getenv("CLOUD_LISTING_SUBMIT_PRICE_MICROFEN"))
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

func legacyTrimKey(key string) string {
	for len(key) > 0 && (key[0] == ' ' || key[0] == '\t' || key[0] == '\n' || key[0] == '\r') {
		key = key[1:]
	}
	for len(key) > 0 && (key[len(key)-1] == ' ' || key[len(key)-1] == '\t' || key[len(key)-1] == '\n' || key[len(key)-1] == '\r') {
		key = key[:len(key)-1]
	}
	return key
}

func TestAILimitsMatchLegacy(t *testing.T) {
	wantValues := map[string]uint32{
		"one": 1, "padded": 42, "tab lf": 42, "cr": 42,
		"vtab": 42, "formfeed": 42, "nbsp": 42,
		"leading zero": 7, "u32 max": 4294967295,
	}
	keys := []string{
		"CLOUD_AI_MAX_CONCURRENCY_GLOBAL",
		"CLOUD_AI_MAX_CONCURRENCY_USER",
		"CLOUD_AI_MAX_CONCURRENCY_ACCOUNT",
		"CLOUD_AI_USER_RATE_PER_MINUTE",
		"CLOUD_AI_LEASE_TTL_SECONDS",
	}
	for i, target := range keys {
		for _, c := range numericEnv {
			t.Run(target+"/"+c.name, func(t *testing.T) {
				for j, key := range keys {
					other := runtimeEnv{name: "other", value: strconv.Itoa(j + 3), set: true}
					if j == i {
						other = c
					}
					setRuntimeEnv(t, key, other)
				}
				got := AILimitsFromEnv()
				mapped := legacyLimits{
					Global:    got.Global,
					User:      got.User,
					Account:   got.Account,
					PerMinute: got.PerMinute,
					LeaseTTL:  time.Duration(got.LeaseTTLSeconds) * time.Second,
				}
				legacy := legacyLimitsFromEnv()
				if mapped != legacy {
					t.Fatalf("%q: got %+v legacy %+v", c.value, mapped, legacy)
				}
				values := [5]uint32{3, 4, 5, 6, 7}
				values[i] = wantValues[c.name]
				if i == 4 && values[i] == 0 {
					values[i] = 90
				}
				want := AILimits{
					Global: values[0], User: values[1], Account: values[2],
					PerMinute: values[3], LeaseTTLSeconds: values[4],
				}
				if got != want {
					t.Fatalf("%q: got %+v want %+v", c.value, got, want)
				}
			})
		}
	}
}

func TestAILimitsDefaults(t *testing.T) {
	for _, key := range []string{
		"CLOUD_AI_MAX_CONCURRENCY_GLOBAL",
		"CLOUD_AI_MAX_CONCURRENCY_USER",
		"CLOUD_AI_MAX_CONCURRENCY_ACCOUNT",
		"CLOUD_AI_USER_RATE_PER_MINUTE",
		"CLOUD_AI_LEASE_TTL_SECONDS",
	} {
		setRuntimeEnv(t, key, runtimeEnv{value: "0", set: true})
	}
	if got := AILimitsFromEnv(); got != (AILimits{LeaseTTLSeconds: 90}) {
		t.Fatalf("zero env: %+v", got)
	}
}

func TestListingSubmitPriceMatchesLegacy(t *testing.T) {
	want := map[string]int64{
		"one":          1,
		"padded":       42,
		"tab lf":       42,
		"cr":           42,
		"plus":         5,
		"leading zero": 7,
		"u32 max":      4294967295,
		"u32 overflow": 4294967296,
		"i64 max":      9223372036854775807,
	}
	for _, c := range numericEnv {
		t.Run(c.name, func(t *testing.T) {
			setRuntimeEnv(t, "CLOUD_LISTING_SUBMIT_PRICE_MICROFEN", c)
			got := ListingSubmitPriceMicrofen()
			if got != legacyListingSubmitPriceMicrofen() || got != want[c.name] {
				t.Fatalf("%q: got %d legacy %d want %d", c.value, got, legacyListingSubmitPriceMicrofen(), want[c.name])
			}
		})
	}
}

func TestWASMPathsMatchLegacy(t *testing.T) {
	readers := map[string]func() string{
		"LISTING_TAGS_WASM": ListingTagsWASMPath,
		"WASM_HOST_PROBE":   WASMHostProbePath,
	}
	for key, read := range readers {
		for _, c := range pathEnv {
			t.Run(key+"/"+c.name, func(t *testing.T) {
				setRuntimeEnv(t, key, c)
				if got, legacy := read(), os.Getenv(key); got != legacy || got != c.value {
					t.Fatalf("%q: got %q legacy %q", c.value, got, legacy)
				}
			})
		}
	}
}
