package config

import (
	"os"
	"strconv"
	"testing"
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

// The legacy* functions are the body removed from billing/repo/operations.go
// (with billing's trimKey), copied byte for byte.

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
