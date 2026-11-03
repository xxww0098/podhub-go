package config

import (
	"reflect"
	"strings"
	"testing"
)

func TestSellerRoutesCapturedOrderedAndValidated(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want []string
	}{
		{"", []string{"direct"}},
		{"socks5h://seller-relay:1080,direct", []string{"socks5h://seller-relay:1080", "direct"}},
		{" socks5h://127.0.0.1:1080\n socks5h://[::1]:1081 ", []string{"socks5h://127.0.0.1:1080", "socks5h://[::1]:1081"}},
	} {
		t.Setenv("CLOUD_SELLER_EGRESS_ROUTES", tc.raw)
		cfg := Load()
		t.Setenv("CLOUD_SELLER_EGRESS_ROUTES", "invalid-after-load")
		got, err := cfg.SellerEgressRoutes()
		if err != nil || !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("routes=%v err=%v", got, err)
		}
		got[0] = "mutated"
		fresh, _ := cfg.SellerEgressRoutes()
		if fresh[0] != tc.want[0] {
			t.Fatal("caller changed captured routes")
		}
	}
	for _, raw := range []string{"http://proxy:1080", "socks5://proxy:1080", "socks5h://proxy", "socks5h://proxy:0", "socks5h://proxy:65536", "socks5h://u:private-secret@proxy:1080", "socks5h://proxy:1080/path", "socks5h://proxy:1080?x=1", "socks5h://proxy:1080#x", "direct,direct", strings.Repeat("direct,", 9)} {
		t.Setenv("CLOUD_SELLER_EGRESS_ROUTES", raw)
		if _, err := Load().SellerEgressRoutes(); err == nil || strings.Contains(err.Error(), "private-secret") {
			t.Fatal("invalid route accepted or echoed")
		}
	}
}
