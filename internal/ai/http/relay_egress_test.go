package aihttp

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/httpx"
)

func TestUpstreamLoopbackBytesMatchPlain(t *testing.T) {
	const payload = `{"id":"c","choices":[]}`
	var seen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		seen = r.Method + " " + r.URL.Path + " " + r.Header.Get("Content-Type") + " " + string(raw)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(payload))
	}))
	t.Cleanup(srv.Close)
	clearProxyEnv(t)
	if httpx.Base(defaultUpstreamClient.Transport) != httpx.Restricted() {
		t.Fatal("upstream default is not the restricted client")
	}
	body := []byte(`{"model":"m"}`)
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/chat/completions", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 5 * time.Second, Transport: httpx.Plain()}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	oldRaw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	oldSeen := seen
	status, raw, err := (HTTPUpstream{}).Complete(context.Background(), srv.URL+"/chat/completions", body)
	if err != nil || status != res.StatusCode || string(raw) != string(oldRaw) || seen != oldSeen || string(raw) != payload {
		t.Fatalf("status %d/%d body %q/%q seen %q/%q err %v", status, res.StatusCode, raw, oldRaw, seen, oldSeen, err)
	}
}

func TestUpstreamSkipsRedirectAndProxy(t *testing.T) {
	var second atomic.Int32
	var sawCred atomic.Bool
	next := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		second.Add(1)
		if r.Header.Get("Client-Id") != "" || r.Header.Get("Api-Key") != "" || r.Header.Get("Authorization") != "" {
			sawCred.Store(true)
		}
		_, _ = w.Write([]byte("followed"))
	}))
	t.Cleanup(next.Close)
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		code := http.StatusTemporaryRedirect
		if strings.HasSuffix(r.URL.Path, "308") {
			code = http.StatusPermanentRedirect
		}
		w.Header().Set("Location", next.URL+"/landed")
		w.WriteHeader(code)
		_, _ = w.Write([]byte("stay"))
	}))
	t.Cleanup(first.Close)
	hits := serveProxy(t)
	for _, path := range []string{"/chat/completions", "/chat/completions308"} {
		status, raw, err := (HTTPUpstream{}).Complete(context.Background(), first.URL+path, []byte(`{"model":"m"}`))
		want := http.StatusTemporaryRedirect
		if strings.HasSuffix(path, "308") {
			want = http.StatusPermanentRedirect
		}
		if err != nil || status != want || string(raw) != "stay" {
			t.Fatalf("%s status %d body %q err %v", path, status, raw, err)
		}
	}
	if _, _, err := (HTTPUpstream{}).Complete(context.Background(), "https://example.com/chat/completions", []byte(`{}`)); err == nil {
		t.Fatal("public upstream was dialed")
	}
	if second.Load() != 0 || sawCred.Load() || hits.Load() != 1 {
		t.Fatalf("second %d creds %v proxy %d", second.Load(), sawCred.Load(), hits.Load())
	}
}

func clearProxyEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"} {
		t.Setenv(key, "")
	}
}

func serveProxy(t *testing.T) *atomic.Int32 {
	t.Helper()
	var hits atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(599)
	}))
	t.Cleanup(proxy.Close)
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("http_proxy", proxy.URL)
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("https_proxy", proxy.URL)
	t.Setenv("ALL_PROXY", "")
	t.Setenv("all_proxy", "")
	t.Setenv("NO_PROXY", "")
	t.Setenv("no_proxy", "")
	req, err := http.NewRequest(http.MethodGet, "http://example.com/models", nil)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(proxy.URL)
	if err != nil {
		t.Fatal(err)
	}
	res, err := (&http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{
		Proxy: func(*http.Request) (*url.URL, error) { return parsed, nil },
	}}).Do(req)
	if err != nil || res.StatusCode != 599 {
		t.Fatalf("proxy control %v", err)
	}
	res.Body.Close()
	return &hits
}
