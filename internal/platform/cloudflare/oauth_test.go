package cloudflare

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func testOAuth() OAuth {
	return OAuth{ClientID: "podhub", ClientSecret: "client-secret", Scopes: "test-r2-scope", RedirectURL: "https://podhub.example/api/workspace/slice-storage/cloudflare/callback"}
}

func TestOAuthValidationAndPKCE(t *testing.T) {
	o := testOAuth()
	if !o.Valid() {
		t.Fatal("valid OAuth settings rejected")
	}
	for _, redirect := range []string{"http://public.example/callback", "https://user@podhub.example/callback", "https://podhub.example/callback?other=1", "/callback"} {
		bad := o
		bad.RedirectURL = redirect
		if bad.Valid() {
			t.Errorf("accepted callback %s", redirect)
		}
	}
	for _, scopes := range []string{"", "test offline_access", "offline"} {
		bad := o
		bad.Scopes = scopes
		if bad.Valid() {
			t.Errorf("accepted scope %s", scopes)
		}
	}
	u, _ := url.Parse(o.AuthorizeURL("state", "challenge"))
	q := u.Query()
	if u.Host != "dash.cloudflare.com" || q.Get("state") != "state" || q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") != "challenge" || q.Get("client_secret") != "" || q.Get("redirect_uri") != o.RedirectURL {
		t.Fatalf("bad authorization URL: %s", u)
	}
}

func TestOAuthExchangeAndRevoke(t *testing.T) {
	var paths []string
	c := New(transportFunc(func(r *http.Request) (*http.Response, error) {
		paths = append(paths, r.URL.Path)
		id, secret, _ := r.BasicAuth()
		if id != "podhub" || secret != "client-secret" || r.URL.Host != "dash.cloudflare.com" || r.URL.RawQuery != "" {
			t.Fatal("wrong OAuth authentication")
		}
		raw, _ := io.ReadAll(r.Body)
		form, _ := url.ParseQuery(string(raw))
		if r.URL.Path == "/oauth2/token" {
			if form.Get("code_verifier") != strings.Repeat("v", 43) || form.Get("grant_type") != "authorization_code" || form.Get("code") != "code" {
				t.Fatal("PKCE/code missing")
			}
			return response(200, `{"access_token":"private-token","token_type":"Bearer","expires_in":3600}`), nil
		}
		if form.Get("token") != "private-token" || form.Get("token_type_hint") != "access_token" {
			t.Fatal("wrong revocation body")
		}
		return response(200, ""), nil
	}))
	token, err := c.Exchange(context.Background(), testOAuth(), "code", strings.Repeat("v", 43))
	if err != nil || token.AccessToken != "private-token" || token.ExpiresIn != 3600 {
		t.Fatalf("exchange failed: %v", err)
	}
	if err := c.Revoke(context.Background(), testOAuth(), token.AccessToken); err != nil || strings.Join(paths, ",") != "/oauth2/token,/oauth2/revoke" {
		t.Fatalf("revoke failed: %v", err)
	}
}

func TestOAuthMalformedTokensNeverEscape(t *testing.T) {
	for _, raw := range []string{
		`{"access_token":"private-token","token_type":"Bearer","expires_in":0}`,
		`{"access_token":"private-token","token_type":"Other","expires_in":60}`,
		`{"error_description":"private-token"}`, `private-token`,
	} {
		c := New(transportFunc(func(*http.Request) (*http.Response, error) { return response(200, raw), nil }))
		token, err := c.Exchange(context.Background(), testOAuth(), "code", strings.Repeat("v", 43))
		if err == nil || token.AccessToken != "" || strings.Contains(err.Error(), "private-token") {
			t.Fatalf("bad token result: %v", err)
		}
	}
}
