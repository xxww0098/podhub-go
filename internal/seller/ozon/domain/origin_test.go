package domain

import (
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

func TestLoopbackOrigin(t *testing.T) {
	ok := []string{
		"http://127.0.0.1:9/",
		"http://localhost:1/",
		"http://[::1]:8080/",
	}
	bad := []string{
		"",
		"https://127.0.0.1:1/",
		"http://127.0.0.1/",
		"http://evil.example:1/",
		"http://127.0.0.1:1/extra",
		"http://user:pass@127.0.0.1:1/",
		"http://127.0.0.1:1/?q=1",
		"https://api-seller.ozon.ru",
	}
	for _, value := range ok {
		if !LoopbackOrigin(value) {
			t.Fatalf("want loopback %s", value)
		}
	}
	for _, value := range bad {
		if LoopbackOrigin(value) {
			t.Fatalf("want reject %s", value)
		}
	}
}

func TestBaseURLIgnoresNonLoopback(t *testing.T) {
	t.Setenv("CLOUD_SELLER_BASE_URL", "https://evil.example")
	if ResolveBaseURL(config.Load().SellerBaseURL()) != ProductionBaseURL {
		t.Fatal(ResolveBaseURL(config.Load().SellerBaseURL()))
	}
	t.Setenv("CLOUD_SELLER_BASE_URL", "http://127.0.0.1:9/")
	cfg := config.Load()
	if ResolveBaseURL(cfg.SellerBaseURL()) != "http://127.0.0.1:9" {
		t.Fatal(ResolveBaseURL(cfg.SellerBaseURL()))
	}
	t.Setenv("CLOUD_SELLER_BASE_URL", "https://evil.example")
	if ResolveBaseURL(cfg.SellerBaseURL()) != "http://127.0.0.1:9" {
		t.Fatal("seller base was read again")
	}
}

func TestRateClass(t *testing.T) {
	if RateClassForPath("/v3/product/import") != ClassDefault {
		t.Fatal("import stays on the default budget")
	}
	if RateClassForPath("/v3/product/info/list") != ClassCatalog {
		t.Fatal("info list")
	}
	if RateClassForPath("/v1/analytics/data") != ClassAnalytics {
		t.Fatal("analytics")
	}
}

func TestKillSwitchIsNotParsedHere(t *testing.T) {
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	cfg := config.Load()
	t.Setenv("OZON_WRITE_KILL_SWITCH", "")
	if !WritesDisabled(cfg) {
		t.Fatal("seller re-read the kill switch")
	}
	if WritesDisabled(config.Config{}) {
		t.Fatal("a zero config must leave writes enabled")
	}
}

func TestScheduleDefaults(t *testing.T) {
	if DefaultRatePerSecond != 5 || DefaultBurst != 10 || DefaultEgressRate != 20 {
		t.Fatal("rate defaults")
	}
	if MaxRateLimitWait != 5*time.Second || SlotWait != 5*time.Second {
		t.Fatal("waits")
	}
	if ReadSlots+InteractiveReadSlots+WriteSlots+InteractiveWriteSlots != 16 {
		t.Fatal("l2 total")
	}
}
