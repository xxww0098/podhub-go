package config

import "testing"

func TestDNSServerCapturedOnce(t *testing.T) {
	t.Setenv("CLOUD_DNS_SERVER", "  [2606:4700:4700::1111]:53 \n")
	cfg := Load()
	t.Setenv("CLOUD_DNS_SERVER", "1.1.1.1:53")
	if cfg.DNSServer != "[2606:4700:4700::1111]:53" {
		t.Fatalf("DNS server was not captured and trimmed: %q", cfg.DNSServer)
	}
	t.Setenv("CLOUD_DNS_SERVER", " \t")
	if got := Load().DNSServer; got != "" {
		t.Fatalf("blank DNS server = %q", got)
	}
}
