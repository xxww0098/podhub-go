package config

import (
	"errors"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"unicode"
)

var errSellerRoutes = errors.New("invalid CLOUD_SELLER_EGRESS_ROUTES: use socks5h://host:port and optional direct")

func sellerEgressRoutesFromEnv() []string {
	raw := strings.TrimSpace(os.Getenv("CLOUD_SELLER_EGRESS_ROUTES"))
	routes := strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || unicode.IsSpace(r) })
	if raw != "" && len(routes) == 0 {
		return []string{raw}
	}
	return routes
}

// SellerEgressRoutes is captured at Load. Direct fallback must be explicit.
func (c Config) SellerEgressRoutes() ([]string, error) {
	if len(c.sellerEgressRoutes) == 0 {
		return []string{"direct"}, nil
	}
	if len(c.sellerEgressRoutes) > 8 {
		return nil, errSellerRoutes
	}
	routes := append([]string(nil), c.sellerEgressRoutes...)
	seen := map[string]bool{}
	for i, route := range routes {
		if seen[route] {
			return nil, errSellerRoutes
		}
		seen[route] = true
		if route == "direct" {
			if i != len(routes)-1 {
				return nil, errSellerRoutes
			}
			continue
		}
		u, err := url.Parse(route)
		if err != nil || u.Scheme != "socks5h" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || strings.Contains(route, "#") || u.Opaque != "" || u.Path != "" {
			return nil, errSellerRoutes
		}
		if _, _, err := net.SplitHostPort(u.Host); err != nil {
			return nil, errSellerRoutes
		}
		port, err := strconv.ParseUint(u.Port(), 10, 16)
		if err != nil || port == 0 {
			return nil, errSellerRoutes
		}
	}
	return routes, nil
}
