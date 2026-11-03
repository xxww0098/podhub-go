// Package domain defines Ozon origin, account and rate-limit rules.
// Generic Egress accepts loopback overrides only; authorized store-bound
// transports use ProductionBaseURL through their own credential checks.
// Configuration parsing stays in internal/platform/config.
package domain

import (
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

const (
	ProductionBaseURL = "https://api-seller.ozon.ru"

	DefaultRatePerSecond   = 5
	DefaultBurst           = 10
	DefaultAnalyticsRate   = 1
	DefaultAnalyticsBurst  = 1
	DefaultCatalogInterval = 2 * time.Second
	DefaultCatalogBurst    = 1
	DefaultEgressRate      = 20
	EgressBurstSeconds     = 2
	MaxRateLimitWait       = 5 * time.Second
	EgressAutoWait         = 2 * time.Second
	SlotWait               = 5 * time.Second
	ReadSlots              = 8
	InteractiveReadSlots   = 4
	WriteSlots             = 2
	InteractiveWriteSlots  = 2
)

// RateClass matches egress.rs rate_class_for_path. Catalog is an exact
// path list. Other /v3/product calls, including import, stay Default.
type RateClass string

const (
	ClassDefault   RateClass = "default"
	ClassAnalytics RateClass = "analytics"
	ClassCatalog   RateClass = "catalog"
)

var catalogPaths = map[string]struct{}{
	"/v3/product/list":        {},
	"/v3/product/info/list":   {},
	"/v4/product/info/stocks": {},
	"/v5/product/info/prices": {},
}

func RateClassForPath(path string) RateClass {
	if strings.HasPrefix(path, "/v1/analytics/") || strings.HasPrefix(path, "/v2/analytics/") {
		return ClassAnalytics
	}
	if _, ok := catalogPaths[path]; ok {
		return ClassCatalog
	}
	return ClassDefault
}

// ResolveBaseURL applies the loopback-origin rule to raw. raw is the string
// captured by config.Load. A non-loopback value becomes the official host,
// which generic Egress refuses to dial. This function does not read the environment.
func ResolveBaseURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if LoopbackOrigin(raw) {
		return strings.TrimRight(raw, "/")
	}
	return ProductionBaseURL
}

// LoopbackOrigin is is_loopback_origin in src/store/egress.rs.
func LoopbackOrigin(value string) bool {
	origin, err := url.Parse(value)
	if err != nil {
		return false
	}
	host := origin.Hostname()
	loopback := strings.EqualFold(host, "localhost")
	if ip := net.ParseIP(host); ip != nil {
		loopback = ip.IsLoopback()
	}
	return origin.Scheme == "http" &&
		loopback &&
		origin.Port() != "" &&
		origin.User == nil &&
		origin.Path == "/" &&
		origin.RawQuery == "" &&
		origin.Fragment == ""
}

// Namespace is CLOUD_SELLER_BUDGET_NAMESPACE, or podhub.
func Namespace() string { return config.SellerBudgetNamespace() }

// WritesDisabled reports the value captured by config.Load. It does not
// read OZON_WRITE_KILL_SWITCH.
func WritesDisabled(cfg config.Config) bool { return cfg.OzonWritesDisabled() }
