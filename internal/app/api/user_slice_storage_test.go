package api

import "testing"

func TestCORSHeaderTokensMatchWholeValues(t *testing.T) {
	if !headerHas(" GET, put ,HEAD", "PUT") || !headerHas("content-type, X-Amz-Checksum-Sha256", "x-amz-checksum-sha256") {
		t.Fatal("valid CORS token was rejected")
	}
	if headerHas("OUTPUT, x-content-type-extra", "PUT") || headerHas("x-content-type-extra", "content-type") {
		t.Fatal("a substring was accepted as a CORS permission")
	}
}
