package httpx

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestTransportBucketsStayApart(t *testing.T) {
	plain := Plain()
	compress := Loopback(false)
	raw := Loopback(true)
	if plain == compress || plain == raw || compress == raw {
		t.Fatalf("buckets aliased plain=%p compress=%p raw=%p", plain, compress, raw)
	}
	if compress.DisableCompression || !raw.DisableCompression {
		t.Fatalf("DisableCompression compress=%v raw=%v", compress.DisableCompression, raw.DisableCompression)
	}
	if plain.DisableCompression {
		t.Fatal("plain transport disables compression")
	}
	if compress.Proxy != nil || raw.Proxy != nil {
		t.Fatal("loopback transport must not consult a proxy")
	}
	if plain.Proxy == nil {
		t.Fatal("plain transport lost ProxyFromEnvironment")
	}
	if Loopback(false) != compress || Loopback(true) != raw || Plain() != plain {
		t.Fatal("transport not process-wide")
	}
}

func TestLoopbackDialRefusesPublicAddresses(t *testing.T) {
	tr := Loopback(false)
	_, err := tr.DialContext(context.Background(), "tcp", "1.2.3.4:80")
	if err == nil || !strings.Contains(err.Error(), "refusing non-loopback media host") {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	conn, err := tr.DialContext(context.Background(), "tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
}

func TestRestrictedRefusesProxyRedirectAndPublicDial(t *testing.T) {
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
		if r.URL.Path == "/308" {
			code = http.StatusPermanentRedirect
		}
		w.Header().Set("Location", next.URL+"/landed")
		w.WriteHeader(code)
		_, _ = w.Write([]byte("stay"))
	}))
	t.Cleanup(first.Close)
	var proxyHits atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyHits.Add(1)
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

	control, err := http.NewRequest(http.MethodGet, "http://example.com/models", nil)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(proxy.URL)
	if err != nil {
		t.Fatal(err)
	}
	cres, err := (&http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{
		Proxy: func(*http.Request) (*url.URL, error) { return parsed, nil },
	}}).Do(control)
	if err != nil || cres.StatusCode != 599 || proxyHits.Load() != 1 {
		if cres != nil {
			cres.Body.Close()
		}
		t.Fatalf("proxy control err=%v hits=%d", err, proxyHits.Load())
	}
	cres.Body.Close()

	client := RestrictedClient()
	if Base(client.Transport) != Restricted() || Restricted() == Plain() || Restricted() == Loopback(false) || Restricted() == Loopback(true) {
		t.Fatal("restricted transport alias")
	}
	if Restricted().Proxy != nil {
		t.Fatal("restricted proxy is set")
	}
	if err := client.CheckRedirect(nil, nil); !errors.Is(err, http.ErrUseLastResponse) {
		t.Fatal(err)
	}
	for _, path := range []string{"/307", "/308"} {
		req, err := http.NewRequest(http.MethodPost, first.URL+path, strings.NewReader(`{"secret":true}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Client-Id", "cid")
		req.Header.Set("Api-Key", "key")
		req.Header.Set("Authorization", "Bearer tok")
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(res.Body)
		res.Body.Close()
		want := http.StatusTemporaryRedirect
		if path == "/308" {
			want = http.StatusPermanentRedirect
		}
		if res.StatusCode != want || string(raw) != "stay" {
			t.Fatalf("%s status %d body %q", path, res.StatusCode, raw)
		}
	}
	pub, err := http.NewRequest(http.MethodGet, "http://example.com/v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Do(pub); err == nil || !errors.Is(err, ErrNotLoopback) {
		t.Fatalf("public dial %v", err)
	}
	if _, err := Restricted().DialContext(context.Background(), "tcp", "1.2.3.4:80"); !errors.Is(err, ErrNotLoopback) {
		t.Fatal(err)
	}
	if second.Load() != 0 || sawCred.Load() || proxyHits.Load() != 1 {
		t.Fatalf("second %d creds %v proxy %d", second.Load(), sawCred.Load(), proxyHits.Load())
	}
}

func TestRestrictedLoopbackBytesMatchPlain(t *testing.T) {
	const payload = `{"items":[{"offer_id":"a"}]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(payload))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("HTTP_PROXY", "")
	t.Setenv("HTTPS_PROXY", "")
	t.Setenv("http_proxy", "")
	t.Setenv("https_proxy", "")
	t.Setenv("ALL_PROXY", "")
	t.Setenv("all_proxy", "")
	fetch := func(tr *http.Transport) (int, string) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, srv.URL+"/v3/product/info/list", strings.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := (&http.Client{Timeout: 5 * time.Second, Transport: tr}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, string(raw)
	}
	oldStatus, oldBody := fetch(Plain())
	newStatus, newBody := fetch(Restricted())
	if oldStatus != newStatus || oldBody != newBody || newBody != payload {
		t.Fatalf("plain %d %q restricted %d %q", oldStatus, oldBody, newStatus, newBody)
	}
}
