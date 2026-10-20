package config

import (
	"os"
	"strconv"
	"testing"
	"time"
)

func TestWriterInstanceID(t *testing.T) {
	t.Setenv(envInstanceID, "  box-7  ")
	if got := Load().WriterInstanceID(); got != "box-7" {
		t.Fatalf("trimmed instance %q", got)
	}
	t.Setenv(envInstanceID, "   ")
	got := Load().WriterInstanceID()
	if got != "axum-"+strconv.Itoa(os.Getpid()) {
		t.Fatalf("blank instance %q", got)
	}
	os.Unsetenv(envInstanceID)
	if got := Load().WriterInstanceID(); got != "axum-"+strconv.Itoa(os.Getpid()) {
		t.Fatalf("unset instance %q", got)
	}
}

func TestOzonKillSwitchMatchesRust(t *testing.T) {
	for _, value := range []string{"1", "true", "yes", "on", " TRUE ", "On"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv(envOzonKillSwitch, value)
			if !Load().OzonWritesDisabled() {
				t.Fatalf("%q must disable writes", value)
			}
		})
	}
	for _, value := range []string{"", "0", "false", "no", "off", "maybe"} {
		t.Run("open/"+value, func(t *testing.T) {
			t.Setenv(envOzonKillSwitch, value)
			if Load().OzonWritesDisabled() {
				t.Fatalf("%q must leave writes enabled", value)
			}
		})
	}
	t.Run("unset", func(t *testing.T) {
		t.Setenv(envOzonKillSwitch, "sentinel")
		os.Unsetenv(envOzonKillSwitch)
		if Load().OzonWritesDisabled() {
			t.Fatal("unset OZON_WRITE_KILL_SWITCH must leave writes enabled")
		}
	})
}

func TestClientLogCollectMatchesTruthy(t *testing.T) {
	for _, value := range []string{"1", "true", "yes", "on", " TRUE ", "On"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv(envClientLogCollect, value)
			if !Load().ClientLogCollect() {
				t.Fatalf("%q must enable collection", value)
			}
		})
	}
	for _, value := range []string{"", "0", "false", "no", "off", "maybe"} {
		t.Run("off/"+value, func(t *testing.T) {
			t.Setenv(envClientLogCollect, value)
			if Load().ClientLogCollect() {
				t.Fatalf("%q must leave collection off", value)
			}
		})
	}
	t.Run("unset", func(t *testing.T) {
		t.Setenv(envClientLogCollect, "sentinel")
		os.Unsetenv(envClientLogCollect)
		if Load().ClientLogCollect() {
			t.Fatal("unset CLOUD_CLIENT_LOG_COLLECT must leave collection off")
		}
	})
}

func TestShippingInjectWritesDefaultOff(t *testing.T) {
	t.Run("unset", func(t *testing.T) {
		t.Setenv(envShippingInject, "sentinel")
		os.Unsetenv(envShippingInject)
		if Load().ShippingInjectWrites() || Load().ShippingInjectOzonWrites() {
			t.Fatal("unset injection writes must stay off")
		}
	})
	for _, value := range []string{"1", "true", "yes", "on", " YES "} {
		t.Run(value, func(t *testing.T) {
			t.Setenv(envShippingInject, value)
			if !Load().ShippingInjectWrites() {
				t.Fatalf("%q must enable injection writes", value)
			}
		})
	}
	for _, value := range []string{"", "0", "false", "no", "off", "maybe"} {
		t.Run("off/"+value, func(t *testing.T) {
			t.Setenv(envShippingInject, value)
			if Load().ShippingInjectOzonWrites() {
				t.Fatalf("%q must leave injection writes off", value)
			}
		})
	}
	t.Setenv(envShippingInject, "1")
	t.Setenv(envOzonKillSwitch, "1")
	cfg := Load()
	if !cfg.ShippingInjectOzonWrites() || !cfg.OzonWritesDisabled() {
		t.Fatal("the two switches are independent")
	}
}

func TestMediaDeleteSwitchMatchesRust(t *testing.T) {
	t.Run("unset", func(t *testing.T) {
		t.Setenv(envMediaGCDelete, "sentinel")
		os.Unsetenv(envMediaGCDelete)
		if !Load().MediaDeleteEnabled() {
			t.Fatal("unset CLOUD_MEDIA_GC_DELETE must enable the purge")
		}
	})
	for _, value := range []string{"1", "true", "on", "yes", " YES "} {
		t.Run(value, func(t *testing.T) {
			t.Setenv(envMediaGCDelete, value)
			if !Load().MediaDeleteEnabled() {
				t.Fatalf("%q must enable the purge", value)
			}
		})
	}
	for _, value := range []string{"0", "false", "off", "no", "", "maybe"} {
		t.Run("off/"+value, func(t *testing.T) {
			t.Setenv(envMediaGCDelete, value)
			if Load().MediaDeleteEnabled() {
				t.Fatalf("%q must leave the purge off", value)
			}
		})
	}
	t.Run("non-utf8", func(t *testing.T) {
		if err := os.Setenv(envMediaGCDelete, "\xff"); err != nil {
			t.Fatalf("setenv: %v", err)
		}
		t.Cleanup(func() { _ = os.Unsetenv(envMediaGCDelete) })
		if Load().MediaDeleteEnabled() {
			t.Fatal("non-UTF-8 CLOUD_MEDIA_GC_DELETE must leave the purge off")
		}
	})
}

func TestQueueEnvReadOnce(t *testing.T) {
	t.Setenv("OZON_PRODUCT_SYNC_DISABLED", " ON ")
	t.Setenv("DELEGATE_SYNC_INTERVAL_MS", "1500")
	t.Setenv("CLOUD_LANE_QUEUED_COST_LIMIT", "2048")
	t.Setenv("CLOUD_WORKER_LISTING_MAX_IN_FLIGHT", "99")
	t.Setenv("CLOUD_RECONCILER_MAX_IN_FLIGHT", "1")
	t.Setenv("CLOUD_SYNC_WORKER_MAX_IN_FLIGHT", "0")
	cfg := Load()
	if !cfg.ProductSyncDisabled() || cfg.DelegateSyncInterval() != 1500*time.Millisecond || cfg.LaneQueuedCostLimit() != 1024 {
		t.Fatalf("sync %v delegate %s lane %d", cfg.ProductSyncDisabled(), cfg.DelegateSyncInterval(), cfg.LaneQueuedCostLimit())
	}
	if cfg.InFlight("listing") != 16 || cfg.InFlight("reconcile") != 1 || cfg.InFlight("sync") != 4 {
		t.Fatalf("in flight listing %d reconcile %d sync %d", cfg.InFlight("listing"), cfg.InFlight("reconcile"), cfg.InFlight("sync"))
	}
	t.Setenv("OZON_PRODUCT_SYNC_DISABLED", "0")
	t.Setenv("CLOUD_LANE_QUEUED_COST_LIMIT", "")
	t.Setenv("DELEGATE_SYNC_INTERVAL_MS", "nope")
	cfg = Load()
	if cfg.ProductSyncDisabled() || cfg.LaneQueuedCostLimit() != 256 || cfg.DelegateSyncInterval() != time.Minute {
		t.Fatalf("disabled %v lane %d delegate %s", cfg.ProductSyncDisabled(), cfg.LaneQueuedCostLimit(), cfg.DelegateSyncInterval())
	}
}

func TestCredentialKeyDoesNotFlipSwitches(t *testing.T) {
	t.Setenv(envSellerKey, "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")
	t.Setenv(envSellerKeyID, " k1 ")
	t.Setenv(envSellerKeyPrevious, "previous")
	t.Setenv(envIntegrationKey, "integration")
	t.Setenv(envOzonKillSwitch, "0")
	t.Setenv(envMediaGCDelete, "0")
	cfg := Load()
	if cfg.OzonWritesDisabled() || cfg.MediaDeleteEnabled() {
		t.Fatal("credential material changed a write switch")
	}
	if cfg.SellerCredentialKeyID != "k1" || cfg.SellerCredentialKey == "" || cfg.IntegrationConfigKey != "integration" {
		t.Fatalf("credential fields were not captured: %+v", cfg)
	}
}

func TestShippingInjectAndRelayDirs(t *testing.T) {
	t.Setenv(envShippingInject, " YES ")
	t.Setenv(envSellerRelayDir, "/var/relay")
	t.Setenv(envSellerRelaySwitch, "")
	cfg := Load()
	if !cfg.ShippingInjectWrites() || cfg.SellerRelayDir() != "/var/relay" || cfg.SellerRelaySwitchDir() != "" {
		t.Fatalf("%+v", cfg)
	}
	if cfg.OzonWritesDisabled() {
		t.Fatal("inject switch must not close Seller writes")
	}
	os.Unsetenv(envShippingInject)
	os.Unsetenv(envSellerRelayDir)
	if Load().ShippingInjectWrites() || Load().SellerRelayDir() != "" {
		t.Fatal("unset inject and relay dir stay off")
	}
}

func TestDelegateAutoDispatch(t *testing.T) {
	t.Run("unset", func(t *testing.T) {
		t.Setenv(envDelegateAuto, "sentinel")
		os.Unsetenv(envDelegateAuto)
		if !Load().DelegateAutoDispatch() {
			t.Fatal("unset DELEGATE_AUTO_DISPATCH must enable auto dispatch")
		}
	})
	for _, value := range []string{"0", "false", "no", "off", " OFF "} {
		t.Run("off/"+value, func(t *testing.T) {
			t.Setenv(envDelegateAuto, value)
			if Load().DelegateAutoDispatch() {
				t.Fatalf("%q must disable auto dispatch", value)
			}
		})
	}
	for _, value := range []string{"", "1", "true", "yes", "maybe"} {
		t.Run("on/"+value, func(t *testing.T) {
			t.Setenv(envDelegateAuto, value)
			if !Load().DelegateAutoDispatch() {
				t.Fatalf("%q must enable auto dispatch", value)
			}
		})
	}
}

func TestAIPublicProbeAndSellerBaseStayOffTheProtectedSwitches(t *testing.T) {
	t.Setenv(envOzonKillSwitch, "1")
	t.Setenv(envMediaGCDelete, "0")
	t.Setenv(envAIPublic, "sentinel")
	os.Unsetenv(envAIPublic)
	t.Setenv(envSellerBase, "sentinel")
	os.Unsetenv(envSellerBase)
	cfg := Load()
	if cfg.AIEgressAllowPublic || cfg.SellerBaseURL() != "" {
		t.Fatalf("public %v base %q", cfg.AIEgressAllowPublic, cfg.SellerBaseURL())
	}
	if !cfg.OzonWritesDisabled() || cfg.MediaDeleteEnabled() {
		t.Fatal("unset public probe changed a protected switch")
	}
	for _, value := range []string{"", "0", "true", "yes", "on", "2"} {
		t.Setenv(envAIPublic, value)
		if Load().AIEgressAllowPublic {
			t.Fatalf("%q must leave the public probe off", value)
		}
	}
	t.Setenv(envAIPublic, "1")
	t.Setenv(envSellerBase, " http://127.0.0.1:9/ ")
	cfg = Load()
	if !cfg.AIEgressAllowPublic || cfg.SellerBaseURL() != "http://127.0.0.1:9/" {
		t.Fatalf("public %v base %q", cfg.AIEgressAllowPublic, cfg.SellerBaseURL())
	}
	if !cfg.OzonWritesDisabled() || cfg.MediaDeleteEnabled() {
		t.Fatal("enabling the public probe changed a protected switch")
	}
	t.Setenv(envAIPublic, "0")
	t.Setenv(envSellerBase, "https://api-seller.ozon.ru")
	if cfg.AIEgressAllowPublic != true || cfg.SellerBaseURL() != "http://127.0.0.1:9/" {
		t.Fatal("Load was read again")
	}
}

func TestRatingSyncConfig(t *testing.T) {
	t.Setenv(envRatingSync, "")
	t.Setenv(envRatingKeep, "")
	t.Setenv(envRatingRank, "")
	cfg := Load()
	if cfg.RatingSyncInterval() != 6*time.Hour || cfg.RatingRetention() != 90*24*time.Hour {
		t.Fatalf("interval %s keep %s", cfg.RatingSyncInterval(), cfg.RatingRetention())
	}
	ranks := cfg.RatingStatusRank()
	if len(ranks) != 1 || ranks["UNKNOWN"] != 0 {
		t.Fatalf("ranks %v", ranks)
	}
	writes, media := cfg.OzonWritesDisabled(), cfg.MediaDeleteEnabled()
	t.Setenv(envRatingSync, "nope")
	if Load().RatingSyncInterval() != 6*time.Hour {
		t.Fatal("bad interval")
	}
	t.Setenv(envRatingSync, "30m")
	t.Setenv(envRatingKeep, "48h")
	t.Setenv(envRatingRank, "OK=1,BAD=3,NOPE")
	cfg = Load()
	if cfg.RatingSyncInterval() != 30*time.Minute || cfg.RatingRetention() != 48*time.Hour {
		t.Fatalf("parsed %s %s", cfg.RatingSyncInterval(), cfg.RatingRetention())
	}
	got := cfg.RatingStatusRank()
	if got["OK"] != 1 || got["BAD"] != 3 || len(got) != 2 {
		t.Fatalf("ranks %v", got)
	}
	if cfg.OzonWritesDisabled() != writes || cfg.MediaDeleteEnabled() != media {
		t.Fatal("rating config changed a protected switch")
	}
}

func TestDatabaseHostMustBeLoopback(t *testing.T) {
	cfg := Config{DatabaseURL: "postgres://ozon:secret@db.example.com:5432/ozon_cloud"}
	if err := cfg.CheckDatabase(); err == nil {
		t.Fatal("remote database host must be refused")
	}
	cfg.DatabaseURL = "postgres://postgres@127.0.0.1:5432/podhub?sslmode=disable"
	if err := cfg.CheckDatabase(); err != nil {
		t.Fatal(err)
	}
}

func TestOTLPTracesEndpoint(t *testing.T) {
	os.Unsetenv(envOTLPTraces)
	if got, err := Load().OTLPTracesEndpoint(); got != "" || err != nil {
		t.Fatalf("unset: %q %v", got, err)
	}
	writes, media := Load().OzonWritesDisabled(), Load().MediaDeleteEnabled()
	cases := []struct {
		raw  string
		want string
		ok   bool
	}{
		{"", "", true},
		{"   ", "", true},
		{" http://127.0.0.1:4318/v1/traces ", "http://127.0.0.1:4318/v1/traces", true},
		{"https://localhost:4318/v1/traces", "https://localhost:4318/v1/traces", true},
		{"http://[::1]:4318/v1/traces", "http://[::1]:4318/v1/traces", true},
		{"http://collector.example:4318/v1/traces", "", false},
		{"http://10.0.0.5:4318/v1/traces", "", false},
		{"grpc://127.0.0.1:4317", "", false},
		{"127.0.0.1:4318", "", false},
		{"::", "", false},
	}
	for _, c := range cases {
		t.Setenv(envOTLPTraces, c.raw)
		cfg := Load()
		got, err := cfg.OTLPTracesEndpoint()
		if got != c.want || (err == nil) != c.ok {
			t.Fatalf("%q: got %q err %v", c.raw, got, err)
		}
		if cfg.OzonWritesDisabled() != writes || cfg.MediaDeleteEnabled() != media {
			t.Fatal("otlp config changed a protected switch")
		}
	}
}
