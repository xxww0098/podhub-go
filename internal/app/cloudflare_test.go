package app

import (
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

func TestCloudflareOAuthUsesConfiguredPublicOrigin(t *testing.T) {
	cfg := config.Config{PublicURL: "https://podhub.example/", CloudflareOAuthClientID: "id", CloudflareOAuthClientSecret: "secret", CloudflareOAuthScopes: "registered-r2-scope"}
	o := cloudflareOAuth(cfg)
	if !o.Valid() || o.RedirectURL != "https://podhub.example/api/workspace/slice-storage/cloudflare/callback" {
		t.Fatalf("invalid configured callback %q", o.RedirectURL)
	}
	for _, origin := range []string{"", "https://podhub.example/subpath", "https://podhub.example?next=other", "http://public.example"} {
		cfg.PublicURL = origin
		if cloudflareOAuth(cfg).Valid() {
			t.Fatalf("accepted bad public origin %s", origin)
		}
	}
}
