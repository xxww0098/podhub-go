package r2

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestAccountOriginBounds(t *testing.T) {
	const endpoint = "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"
	account := sigv4.Account{Provider: sigv4.ProviderCloudflare, Endpoint: endpoint, PublicBaseURL: "https://assets.example.com"}
	tests := []struct {
		name, method, target string
		endpoint, public     string
		want                 bool
	}{
		{name: "API get", method: "GET", target: endpoint + "/bucket/key?X-Amz-Signature=secret", want: true},
		{name: "API put", method: "PUT", target: endpoint + "/bucket/key", want: true},
		{name: "API delete", method: "DELETE", target: endpoint + "/bucket/key", want: true},
		{name: "public get", method: "GET", target: "https://assets.example.com/key", want: true},
		{name: "public head", method: "HEAD", target: "https://assets.example.com/key", want: true},
		{name: "public write", method: "PUT", target: "https://assets.example.com/key"},
		{name: "other account", method: "GET", target: "https://fedcba9876543210fedcba9876543210.r2.cloudflarestorage.com/bucket/key"},
		{name: "other public host", method: "GET", target: "https://other.example.com/key"},
		{name: "http", method: "GET", target: strings.Replace(endpoint, "https:", "http:", 1) + "/key"},
		{name: "port", method: "GET", target: endpoint + ":8443/key"},
		{name: "userinfo", method: "GET", target: strings.Replace(endpoint, "https://", "https://secret@", 1) + "/key"},
		{name: "fragment", method: "GET", target: endpoint + "/key#fragment"},
		{name: "wrong suffix", method: "GET", endpoint: endpoint + ".example.com", target: endpoint + ".example.com/key"},
		{name: "bad API account", method: "GET", endpoint: "https://unknown.r2.cloudflarestorage.com", target: "https://unknown.r2.cloudflarestorage.com/key"},
		{name: "bad endpoint path", method: "GET", endpoint: endpoint + "/other", target: endpoint + "/key"},
		{name: "bad endpoint query", method: "GET", endpoint: endpoint + "?other=true", target: endpoint + "/key"},
		{name: "public localhost", method: "GET", public: "https://localhost", target: "https://localhost/key"},
		{name: "public IP", method: "GET", public: "https://127.0.0.1", target: "https://127.0.0.1/key"},
		{name: "local configured", method: "GET", endpoint: "http://127.0.0.1:1234", target: "http://127.0.0.1:1234/bucket/key", want: true},
		{name: "local wrong port", method: "GET", endpoint: "http://127.0.0.1:1234", target: "http://127.0.0.1:1235/bucket/key"},
		{name: "local other host", method: "GET", endpoint: "http://127.0.0.1:1234", target: "http://localhost:1234/bucket/key"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			configured := account
			if tc.endpoint != "" {
				configured.Endpoint = tc.endpoint
			}
			if tc.public != "" {
				configured.PublicBaseURL = tc.public
			}
			_, err := accountOrigin(configured, Request{Method: tc.method, URL: tc.target})
			if (err == nil) != tc.want {
				t.Fatalf("allowed=%v want=%v err=%v", err == nil, tc.want, err)
			}
		})
	}
}

func TestPublicOriginIPs(t *testing.T) {
	for _, raw := range []string{"0.1.2.3", "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "::", "::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "2001:db8::1"} {
		if publicOriginIP(netip.MustParseAddr(raw)) {
			t.Errorf("accepted non-public address %s", raw)
		}
	}
	for _, raw := range []string{"1.1.1.1", "104.16.1.1", "2606:4700:4700::1111"} {
		if !publicOriginIP(netip.MustParseAddr(raw)) {
			t.Errorf("rejected public address %s", raw)
		}
	}
}

func TestExchangeAccountDoesNotFollowRedirect(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		http.Redirect(w, r, "http://127.0.0.1:1/internal", http.StatusFound)
	}))
	defer srv.Close()
	resp, err := ExchangeAccount(context.Background(), sigv4.Account{Endpoint: srv.URL}, Request{Method: "GET", URL: srv.URL + "/bucket/key"})
	if err != nil || resp.Status != http.StatusFound || requests != 1 {
		t.Fatalf("status=%d requests=%d err=%v", resp.Status, requests, err)
	}
}

func TestExchangeAccountDoesNotLeakSignedURL(t *testing.T) {
	_, err := ExchangeAccount(context.Background(), sigv4.Account{Endpoint: "http://127.0.0.1:0"}, Request{Method: "GET", URL: "http://127.0.0.1:0/key?X-Amz-Signature=secret-value"})
	if err == nil || strings.Contains(err.Error(), "secret-value") || strings.Contains(err.Error(), "X-Amz") {
		t.Fatalf("unexpected error %v", err)
	}
}
