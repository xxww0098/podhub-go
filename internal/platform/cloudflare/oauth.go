package cloudflare

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const authURL = "https://dash.cloudflare.com/oauth2/"

type OAuth struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string
	Scopes       string
}

// Valid requires an explicit callback origin and the scopes registered on our client.
// This is a short-lived setup grant, so offline/refresh access is not requested.
func (o OAuth) Valid() bool {
	u, err := url.Parse(o.RedirectURL)
	if err != nil || u.User != nil || u.Hostname() == "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		return false
	}
	for _, scope := range strings.Fields(o.Scopes) {
		if scope == "offline" || scope == "offline_access" {
			return false
		}
	}
	return strings.TrimSpace(o.ClientID) != "" && strings.TrimSpace(o.ClientSecret) != "" && len(strings.Fields(o.Scopes)) > 0
}

func (o OAuth) AuthorizeURL(state, challenge string) string {
	q := url.Values{
		"response_type": {"code"}, "client_id": {o.ClientID}, "redirect_uri": {o.RedirectURL},
		"scope": {o.Scopes}, "state": {state}, "code_challenge": {challenge}, "code_challenge_method": {"S256"},
	}
	return authURL + "auth?" + q.Encode()
}

type Token struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int64  `json:"expires_in"`
}

func (c *Client) oauthRequest(ctx context.Context, o OAuth, path string, form url.Values) (*http.Response, error) {
	if !o.Valid() {
		return nil, ErrInput
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, authURL+path, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, ErrInput
	}
	req.SetBasicAuth(url.QueryEscape(o.ClientID), url.QueryEscape(o.ClientSecret))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &Error{}
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, &Error{Status: resp.StatusCode}
	}
	return resp, nil
}

func (c *Client) Exchange(ctx context.Context, o OAuth, code, verifier string) (Token, error) {
	if code == "" || len(code) > 8192 || len(verifier) < 43 || len(verifier) > 128 {
		return Token{}, ErrInput
	}
	resp, err := c.oauthRequest(ctx, o, "token", url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {o.RedirectURL}, "code_verifier": {verifier},
	})
	if err != nil {
		return Token{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (32<<10)+1))
	var token Token
	if err != nil || len(raw) > 32<<10 || json.Unmarshal(raw, &token) != nil || !validToken(token.AccessToken) || !strings.EqualFold(token.TokenType, "Bearer") || token.ExpiresIn <= 0 {
		return Token{}, &Error{}
	}
	return token, nil
}

func (c *Client) Revoke(ctx context.Context, o OAuth, token string) error {
	if !validToken(token) {
		return ErrInput
	}
	resp, err := c.oauthRequest(ctx, o, "revoke", url.Values{"token": {token}, "token_type_hint": {"access_token"}})
	if err == nil {
		resp.Body.Close()
	}
	return err
}
