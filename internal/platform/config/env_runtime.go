package config

import (
	"os"
	"strconv"
)

// This reader runs on every call, not once at Load.

const envSubmitPrice = "CLOUD_LISTING_SUBMIT_PRICE_MICROFEN"

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
