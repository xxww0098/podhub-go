package app

import (
	"context"
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

func TestSellerRelayOptionsCaptureRouteAndStrictProbe(t *testing.T) {
	t.Setenv("CLOUD_SELLER_EGRESS_ROUTES", "socks5h://127.0.0.1:1080,socks5h://127.0.0.1:1081,direct")
	t.Setenv("CLOUD_SELLER_RELAY_DIR", " "+t.TempDir()+" ")
	t.Setenv("CLOUD_SELLER_RELAY_SWITCH_DIR", t.TempDir())
	opt := sellerRelayOptions(config.Load())
	if opt.Route != "socks5h://127.0.0.1:1080" || opt.Probe == nil || opt.Dir[0] == ' ' {
		t.Fatal("management relay route was not wired from captured configuration")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := opt.Probe(ctx, opt.Route); err == nil {
		t.Fatal("unstarted proxy reported reachable through direct fallback")
	}
	t.Setenv("CLOUD_SELLER_EGRESS_ROUTES", "direct")
	if direct := sellerRelayOptions(config.Load()); direct.Route != "" {
		t.Fatal("direct-only configuration advertised a relay")
	}
}
