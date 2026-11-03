package domain

import (
	"errors"
	"testing"

	"github.com/xxww0098/podhub-go/internal/mcp/contract"
)

func TestAllowList(t *testing.T) {
	a := Allow{Hosts: []string{"MCP.Example:443"}, Origins: []string{"https://app.example"}}
	if !a.HostOK("mcp.example:443") || a.HostOK("mcp.example:8443") || a.HostOK("other") || a.HostOK("") {
		t.Fatal("host")
	}
	if code, body := a.CheckHost("mcp.example:9"); code != 403 || body != "Forbidden: Host header is not allowed" {
		t.Fatalf("port %d %s", code, body)
	}
	if !a.OriginOK("") || !a.OriginOK("https://app.example") || a.OriginOK("https://evil.example") {
		t.Fatal("origin")
	}
	if code, body := a.CheckOrigin("https://evil.example"); code != 403 || body != "Forbidden: Origin header is not allowed" {
		t.Fatalf("origin body %d %s", code, body)
	}
	empty := Allow{}
	if !empty.HostOK("localhost") || !empty.HostOK("127.0.0.1:8080") || empty.HostOK("evil.example") {
		t.Fatal("default hosts")
	}
	if !empty.OriginOK("https://app.example") || !empty.OriginOK("") {
		t.Fatal("empty origins skip the check")
	}
}

func TestBearer(t *testing.T) {
	token, err := BearerToken("Bearer opa_abc")
	if err != nil || token != "opa_abc" {
		t.Fatalf("%q %v", token, err)
	}
	for _, header := range []string{"", "Bearer ", "Bearer opa_", "Basic opa_abc", "Bearer token", "Bearer opa_a b"} {
		if _, err := BearerToken(header); !errors.Is(err, contract.ErrBearerDenied) {
			t.Fatalf("%q %v", header, err)
		}
	}
}

func TestOriginTuple(t *testing.T) {
	for _, tc := range []struct {
		allowed, origin string
		want            int
	}{
		{"https://app.example:443", "https://APP.example", 0},
		{"https://app.example", "https://app.example:443", 0},
		{"https://app.example", "https://app.example:8443", 403},
		{"http://localhost:80", "http://localhost", 0},
		{"http://localhost", "http://localhost:8080", 403},
		{"http://localhost:8080", "http://localhost:8080", 0},
		{"https://[::1]", "https://[::1]:443", 0},
		{"https://app.example", "https://app.example:", 400},
		{"https://app.example", "https://app.example:65536", 400},
		{"https://app.example", "https://app.example/path", 400},
		{"https://app.example", "https://user@app.example", 400},
		{"https://app.example", "https://app.example?", 400},
		{"https://app.example", "https://app.example#", 400},
		{"https://user@app.example", "https://app.example", 403},
		{"https://app.example/path", "https://app.example", 403},
		{"https://app.example?query=value", "https://app.example", 403},
		{"https://app.example#fragment", "https://app.example", 403},
		{"https://app.example:", "https://app.example", 403},
		{"https://app.example:65536", "https://app.example", 403},
	} {
		t.Run(tc.allowed+" -> "+tc.origin, func(t *testing.T) {
			if code, body := (Allow{Origins: []string{tc.allowed}}).CheckOrigin(tc.origin); code != tc.want {
				t.Fatalf("CheckOrigin = %d %q, want %d", code, body, tc.want)
			}
		})
	}
	if code, body := (Allow{Hosts: []string{"app.example"}}).CheckHost("app.example:8443"); code != 0 {
		t.Fatalf("Host without a configured port should retain its independent wildcard: %d %s", code, body)
	}
}
