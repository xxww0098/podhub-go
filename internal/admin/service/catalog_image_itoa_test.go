package service

import (
	"math"
	"testing"
)

func TestCatalogItoa64(t *testing.T) {
	for _, c := range []struct {
		n    int64
		want string
	}{
		{0, "0"}, {1, "1"}, {-1, "-1"}, {10, "10"},
		{math.MaxInt64, "9223372036854775807"},
		{math.MinInt64 + 1, "-9223372036854775807"},
		{math.MinInt64, "-9223372036854775808"},
	} {
		if got := itoa64(c.n); got != c.want {
			t.Fatalf("%d: got %q want %q", c.n, got, c.want)
		}
	}
}
