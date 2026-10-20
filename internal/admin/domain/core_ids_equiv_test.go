package domain

import (
	"math"
	"strings"
	"testing"
)

// legacyCanonicalUUID is the admin/domain body before it moved to admin/core/contract.
func legacyCanonicalUUID(raw string) (string, bool) {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = strings.TrimPrefix(s, "urn:uuid:")
	if len(s) >= 2 && s[0] == '{' && s[len(s)-1] == '}' {
		s = s[1 : len(s)-1]
	}
	hexDigits := strings.ReplaceAll(s, "-", "")
	if len(hexDigits) != 32 {
		return "", false
	}
	for _, c := range hexDigits {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return "", false
		}
	}
	return hexDigits[0:8] + "-" + hexDigits[8:12] + "-" + hexDigits[12:16] + "-" + hexDigits[16:20] + "-" + hexDigits[20:32], true
}

func TestCanonicalUUIDMatchesLegacy(t *testing.T) {
	for _, raw := range []string{
		"", "nope", "  AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA ",
		"aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa", "urn:uuid:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
		"{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}", "{}", "{", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaag",
		"a-a-a-a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaaa",
	} {
		got, ok := CanonicalUUID(raw)
		want, wantOK := legacyCanonicalUUID(raw)
		if got != want || ok != wantOK {
			t.Fatalf("%q: got %q %v want %q %v", raw, got, ok, want, wantOK)
		}
	}
}

func TestItoa64(t *testing.T) {
	for _, c := range []struct {
		n    int64
		want string
	}{
		{0, "0"}, {1, "1"}, {-1, "-1"}, {9, "9"}, {10, "10"}, {-10, "-10"},
		{1789900000000, "1789900000000"}, {-1789900000000, "-1789900000000"},
		{math.MaxInt64, "9223372036854775807"},
		{math.MinInt64 + 1, "-9223372036854775807"},
		{math.MinInt64, "-9223372036854775808"},
	} {
		if got := itoa64(c.n); got != c.want {
			t.Fatalf("%d: got %q want %q", c.n, got, c.want)
		}
	}
}

func TestFailMatchesLegacy(t *testing.T) {
	e := Fail(400, "validation", "请求格式无效")
	if e.Status != 400 || e.Code != "validation" || e.Message != "请求格式无效" || e.RetryAfter != "" || e.Error() != "请求格式无效" {
		t.Fatalf("%+v", *e)
	}
	n := NotPorted()
	if n.Status != 501 || n.Code != "not_ported" || n.Message != "not_ported" || n.RetryAfter != "" {
		t.Fatalf("%+v", *n)
	}
	var nilErr *APIError
	if nilErr.Error() != "" {
		t.Fatal("nil APIError")
	}
}
