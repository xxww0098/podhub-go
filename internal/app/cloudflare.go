package app

import (
	"net/url"
	"strings"

	"github.com/xxww0098/podhub-go/internal/platform/cloudflare"
	"github.com/xxww0098/podhub-go/internal/platform/config"
)

func cloudflareOAuth(cfg config.Config) cloudflare.OAuth {
	u, err := url.Parse(cfg.PublicURL)
	if err != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
		return cloudflare.OAuth{}
	}
	return cloudflare.OAuth{
		ClientID: cfg.CloudflareOAuthClientID, ClientSecret: cfg.CloudflareOAuthClientSecret, Scopes: cfg.CloudflareOAuthScopes,
		RedirectURL: strings.TrimRight(cfg.PublicURL, "/") + "/api/workspace/slice-storage/cloudflare/callback",
	}
}
