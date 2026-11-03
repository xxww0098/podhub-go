package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/identity"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/cloudflare"
)

const cfAccountID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type cfTransport func(*http.Request) (*http.Response, error)

func (f cfTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func cfResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func cfServer(transport cfTransport) (*Server, *access.Principal) {
	p := &access.Principal{UserID: 9, OrgID: 4, WorkspaceRole: "owner", PlatformRole: "user", TokenHash: "podhub-login-a"}
	now := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	return &Server{
		Access: access.FixedResolver{Principal: p}, Now: func() time.Time { return now },
		SliceStorageKey: []byte(strings.Repeat("k", 32)), Cloudflare: cloudflare.New(transport),
		CloudflareOAuth: cloudflare.OAuth{ClientID: "podhub", ClientSecret: "client-secret", Scopes: "test-r2-scope", RedirectURL: "https://podhub.example" + cloudflarePath + "/callback"},
	}, p
}

func cfCall(s *Server, method, path, body string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "https://podhub.example"+path, strings.NewReader(body))
	req.Header.Set("Origin", "https://podhub.example")
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "sid", Value: "login-a"})
	for _, cookie := range cookies {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	identity.CSRF(HandlerFromMux(s, nil)).ServeHTTP(rec, req)
	return rec
}

func cfGrantCookie(t *testing.T, s *Server, p access.Principal, name string, grant cloudflareGrant) *http.Cookie {
	t.Helper()
	rec := httptest.NewRecorder()
	if err := s.saveCloudflareGrant(rec, p, name, grant); err != nil {
		t.Fatal(err)
	}
	return rec.Result().Cookies()[0]
}

func TestCloudflareOAuthConnectAndRevoke(t *testing.T) {
	var challenge string
	var calls []string
	s, _ := cfServer(func(r *http.Request) (*http.Response, error) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		if r.URL.Host == "dash.cloudflare.com" {
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			if r.URL.Path == "/oauth2/token" {
				sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
				if base64.RawURLEncoding.EncodeToString(sum[:]) != challenge {
					t.Fatal("authorization and exchange PKCE differ")
				}
				return cfResponse(200, `{"access_token":"private-token","token_type":"Bearer","expires_in":3600}`), nil
			}
			if r.Form.Get("token") != "private-token" {
				t.Fatal("wrong revoke credential")
			}
			return cfResponse(200, ""), nil
		}
		if r.Header.Get("Authorization") != "Bearer private-token" {
			t.Fatal("management API did not use the session grant")
		}
		if r.URL.Path == "/client/v4/accounts" {
			return cfResponse(200, `{"success":true,"result":[{"id":"`+cfAccountID+`","name":"Authorized account"}]}`), nil
		}
		return cfResponse(200, `{"success":true,"result":{"name":"my-slices","creation_date":"2026-11-02T00:00:00Z"}}`), nil
	})
	start := cfCall(s, "POST", cloudflarePath+"/authorize", "")
	var auth struct {
		URL string `json:"authorization_url"`
	}
	if start.Code != 200 || json.Unmarshal(start.Body.Bytes(), &auth) != nil {
		t.Fatalf("authorize %d %s", start.Code, start.Body.String())
	}
	u, _ := url.Parse(auth.URL)
	challenge = u.Query().Get("code_challenge")
	stateCookie := start.Result().Cookies()[0]
	if !stateCookie.HttpOnly || !stateCookie.Secure || stateCookie.SameSite != http.SameSiteLaxMode || stateCookie.Path != workspaceSlicePath || strings.Contains(start.Body.String(), "client-secret") {
		t.Fatal("authorization credentials are not protected")
	}
	callback := cfCall(s, "GET", cloudflarePath+"/callback?code=provider-code&state="+u.Query().Get("state"), "", stateCookie)
	if callback.Code != 303 || strings.Contains(callback.Body.String(), "private-token") || callback.Header().Get("Cache-Control") != "no-store" || callback.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("callback %d %s", callback.Code, callback.Body.String())
	}
	var tokenCookie *http.Cookie
	for _, cookie := range callback.Result().Cookies() {
		if cookie.Name == cloudflareTokenCookie {
			tokenCookie = cookie
		}
	}
	if tokenCookie == nil || tokenCookie.Path != workspaceSlicePath || tokenCookie.MaxAge != 900 || strings.Contains(tokenCookie.Value, "private-token") {
		t.Fatal("missing encrypted short-lived setup grant")
	}
	for _, path := range []string{cloudflarePath, cloudflarePath + "/accounts"} {
		rec := cfCall(s, "GET", path, "", tokenCookie)
		if rec.Code != 200 || strings.Contains(rec.Body.String(), "private-token") {
			t.Fatalf("read %d %s", rec.Code, rec.Body.String())
		}
	}
	revoked := cfCall(s, "DELETE", cloudflarePath, "", tokenCookie)
	if revoked.Code != 204 || len(revoked.Result().Cookies()) != 2 {
		t.Fatalf("revoke %d %s", revoked.Code, revoked.Body.String())
	}

}

func TestCloudflareGrantIsolationExpiryAndTampering(t *testing.T) {
	s, p := cfServer(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid grant reached Cloudflare")
		return nil, nil
	})
	valid := cfGrantCookie(t, s, *p, cloudflareTokenCookie, cloudflareGrant{Token: "private-token", ExpiresAt: s.now().Add(time.Minute).Unix()})
	expired := cfGrantCookie(t, s, *p, cloudflareTokenCookie, cloudflareGrant{Token: "private-token", ExpiresAt: s.now().Unix()})
	tampered := *valid
	tampered.Value = "invalid"
	for _, cookie := range []*http.Cookie{nil, expired, &tampered} {
		var cookies []*http.Cookie
		if cookie != nil {
			cookies = append(cookies, cookie)
		}
		rec := cfCall(s, "GET", cloudflarePath+"/accounts", "", cookies...)
		if rec.Code != 409 {
			t.Fatalf("invalid grant %d %s", rec.Code, rec.Body.String())
		}
	}
	for _, change := range []func(){func() { p.OrgID++ }, func() { p.OrgID--; p.UserID++ }, func() { p.UserID--; p.TokenHash = "another-login" }} {
		change()
		if rec := cfCall(s, "GET", cloudflarePath+"/accounts", "", valid); rec.Code != 409 {
			t.Fatalf("grant crossed workspace/user/session: %d", rec.Code)
		}
	}
}

func TestCloudflareDisconnectExpiredAndFailedRevocation(t *testing.T) {
	s, p := cfServer(func(*http.Request) (*http.Response, error) { return cfResponse(503, ""), nil })
	expired := cfGrantCookie(t, s, *p, cloudflareTokenCookie, cloudflareGrant{Token: "private-token", ExpiresAt: s.now().Unix()})
	for _, cookies := range [][]*http.Cookie{nil, {expired}} {
		rec := cfCall(s, "DELETE", cloudflarePath, "", cookies...)
		if rec.Code != 204 || len(rec.Result().Cookies()) != 2 {
			t.Fatalf("expired or absent grant: %d %s", rec.Code, rec.Body.String())
		}
	}
	valid := cfGrantCookie(t, s, *p, cloudflareTokenCookie, cloudflareGrant{Token: "private-token", ExpiresAt: s.now().Add(time.Minute).Unix()})
	rec := cfCall(s, "DELETE", cloudflarePath, "", valid)
	if rec.Code != 502 || len(rec.Result().Cookies()) != 0 {
		t.Fatalf("failed revocation must retain the grant for retry: %d %s", rec.Code, rec.Body.String())
	}
	p.WorkspaceRole = "member"
	if rec := cfCall(s, "DELETE", cloudflarePath, "", valid); rec.Code != 403 {
		t.Fatalf("member could disconnect owner grant: %d", rec.Code)
	}
}

func TestCloudflareCallbackValidatesStateBeforeExchange(t *testing.T) {
	s, p := cfServer(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid OAuth state reached token endpoint")
		return nil, nil
	})
	cookie := cfGrantCookie(t, s, *p, cloudflareStateCookie, cloudflareGrant{State: "expected-state", Verifier: strings.Repeat("v", 43), ExpiresAt: s.now().Add(time.Minute).Unix()})
	for _, tc := range []struct{ query, result string }{
		{"state=wrong&code=x", "invalid_state"},
		{"code=x", "invalid_state"},
		{"state=expected-state&state=other&code=x", "invalid_state"},
		{"state=expected-state&error=access_denied", "denied"},
		{"state=expected-state&code=x&code=y", "failed"},
	} {
		rec := cfCall(s, "GET", cloudflarePath+"/callback?"+tc.query, "", cookie)
		want := "https://podhub.example/?settings=workspace-storage#cloudflare_error=" + tc.result
		if rec.Code != 303 || rec.Header().Get("Location") != want || rec.Result().Cookies()[0].MaxAge != -1 || rec.Header().Get("Referrer-Policy") != "no-referrer" {
			t.Fatalf("invalid callback %d %s %s", rec.Code, rec.Header().Get("Location"), rec.Body.String())
		}
	}
}

func TestCloudflareCallbackExchangeFailureReturnsToStaffSettings(t *testing.T) {
	s, p := cfServer(func(*http.Request) (*http.Response, error) { return cfResponse(503, ""), nil })
	p.PlatformRole = "admin"
	cookie := cfGrantCookie(t, s, *p, cloudflareStateCookie, cloudflareGrant{State: "expected-state", Verifier: strings.Repeat("v", 43), ExpiresAt: s.now().Add(time.Minute).Unix()})
	rec := cfCall(s, "GET", cloudflarePath+"/callback?state=expected-state&code=private-code", "", cookie)
	if rec.Code != 303 || rec.Header().Get("Location") != "https://podhub.example/admin?settings=workspace-storage#cloudflare_error=failed" || strings.Contains(rec.Header().Get("Location"), "private-code") {
		t.Fatalf("failed exchange: %d %s", rec.Code, rec.Header().Get("Location"))
	}
}

func TestCloudflareRoutesRequireSessionConfigurationAndSameOrigin(t *testing.T) {
	s, p := cfServer(func(*http.Request) (*http.Response, error) {
		t.Fatal("refused request reached Cloudflare")
		return nil, nil
	})
	s.Access = access.FixedResolver{}
	if rec := cfCall(s, "POST", cloudflarePath+"/authorize", ""); rec.Code != 401 {
		t.Fatalf("logged out: %d", rec.Code)
	}
	s.Access = access.FixedResolver{Principal: p}
	p.OrgID = 0
	if rec := cfCall(s, "POST", cloudflarePath+"/authorize", ""); rec.Code != 403 {
		t.Fatalf("not a workspace member: %d", rec.Code)
	}
	p.OrgID = 4
	s.CloudflareOAuth.ClientID = ""
	if rec := cfCall(s, "POST", cloudflarePath+"/authorize", ""); rec.Code != 503 {
		t.Fatalf("unconfigured: %d", rec.Code)
	}
	req := httptest.NewRequest("POST", "https://podhub.example"+cloudflarePath+"/authorize", nil)
	req.AddCookie(&http.Cookie{Name: "sid", Value: "login-a"})
	req.Header.Set("Origin", "https://attacker.example")
	rec := httptest.NewRecorder()
	identity.CSRF(HandlerFromMux(s, nil)).ServeHTTP(rec, req)
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), "csrf_rejected") {
		t.Fatalf("cross-origin write: %d %s", rec.Code, rec.Body.String())
	}
}
