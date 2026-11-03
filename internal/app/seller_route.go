package app

import (
	"context"
	"strings"

	adminsvc "github.com/xxww0098/podhub-go/internal/admin/service"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	seller "github.com/xxww0098/podhub-go/internal/seller/ozon"
)

func sellerRelayOptions(cfg config.Config) adminsvc.RelayOptions {
	opt := adminsvc.RelayOptions{Dir: strings.TrimSpace(cfg.SellerRelayDir()), SwitchDir: strings.TrimSpace(cfg.SellerRelaySwitchDir())}
	routes, err := cfg.SellerEgressRoutes()
	if err != nil {
		return opt
	}
	for _, route := range routes {
		if strings.HasPrefix(route, "socks5h://") {
			opt.Route = route
			break
		}
	}
	opt.Probe = func(ctx context.Context, route string) error {
		return seller.ProbeRelay(ctx, route, opt.Dir, opt.SwitchDir)
	}
	return opt
}
