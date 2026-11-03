package ozon

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

func TestCredentialProbeOnlyOfficialRoles(t *testing.T) {
	previous := officialHTTPClient
	t.Cleanup(func() { officialHTTPClient = previous })
	calls := 0
	copy := *officialHTTPClient
	copy.Transport = officialRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		body, _ := io.ReadAll(r.Body)
		if r.Method != http.MethodPost || r.URL.String() != "https://api-seller.ozon.ru/v1/roles" || r.Header.Get("Client-Id") != "test-client" || r.Header.Get("Api-Key") != "test-key" || string(body) != `{}` {
			t.Fatal("credential probe escaped its fixed method, path or credential")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"roles":[]}`)), Header: http.Header{}, Request: r}, nil
	})
	officialHTTPClient = &copy
	e := New(config.Config{})
	// Credential liveness remains a read when all seller writes are disabled.
	e.writesDisabled = true
	if reply, err := e.ProbeRoles(context.Background(), "test-client", "test-key"); err != nil || reply.Status != 200 || calls != 1 || e.ReadPosts() != 1 || e.WritePosts() != 0 {
		t.Fatalf("probe status=%d calls=%d err=%v", reply.Status, calls, err)
	}
	if _, err := e.Call(context.Background(), http.MethodPost, "/v1/roles", []byte(`{}`), false, true, "test-client", "test-key"); err == nil || calls != 1 {
		t.Fatal("generic egress gained an official route")
	}
	for _, key := range []string{"", "bad\r\nkey", strings.Repeat("k", 4097)} {
		if _, err := e.ProbeRoles(context.Background(), "test-client", key); err == nil || calls != 1 {
			t.Fatal("invalid credential was sent")
		}
	}
	if _, err := (*Egress)(nil).ProbeRoles(context.Background(), "test-client", "test-key"); err == nil {
		t.Fatal("nil egress accepted")
	}
	if _, err := (&Egress{base: "https://attacker.invalid"}).ProbeRoles(context.Background(), "test-client", "test-key"); err == nil || calls != 1 {
		t.Fatal("another upstream accepted")
	}
}
