package app

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

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	sellerdomain "github.com/xxww0098/podhub-go/internal/seller/domain"
)

func TestDelegateSellerBytesMatchPlain(t *testing.T) {
	const payload = `{"result":{"postings":[]}}`
	var seen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		seen = r.Method + " " + r.URL.Path + " " + r.Header.Get("Content-Type") + " " + r.Header.Get("Client-Id") + " " + r.Header.Get("Api-Key") + " " + string(raw)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(payload))
	}))
	t.Cleanup(srv.Close)
	for _, key := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"} {
		t.Setenv(key, "")
	}
	if httpx.Base(delegateSellerClient.Transport) != httpx.Ozon() || httpx.Ozon() == httpx.Restricted() {
		t.Fatal("delegate seller client is not the ozon client")
	}
	body := []byte(`{"filter":{}}`)
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/v3/posting/fbs/list", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Client-Id", "cid")
	req.Header.Set("Api-Key", "key")
	res, err := (&http.Client{Timeout: 5 * time.Second, Transport: httpx.Plain()}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	oldRaw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	oldSeen := seen
	status, raw, kind, err := postDelegateSeller(context.Background(), srv.URL, "cid", "key", "/v3/posting/fbs/list", body)
	if err != nil || kind != "" || status != res.StatusCode || string(raw) != string(oldRaw) || seen != oldSeen {
		t.Fatalf("status %d/%d body %q/%q seen %q/%q kind %s err %v", status, res.StatusCode, raw, oldRaw, seen, oldSeen, kind, err)
	}
}

func TestDelegateSellerSkipsRedirectAndProxy(t *testing.T) {
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
	redirector := func(code int) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", next.URL+"/landed")
			w.WriteHeader(code)
			_, _ = w.Write([]byte("stay"))
		}))
	}
	hop307 := redirector(http.StatusTemporaryRedirect)
	hop308 := redirector(http.StatusPermanentRedirect)
	t.Cleanup(hop307.Close)
	t.Cleanup(hop308.Close)
	hits := serveProxy(t)
	for _, base := range []string{hop307.URL, hop308.URL} {
		status, raw, kind, err := postDelegateSeller(context.Background(), base, "cid", "key", "/v3/posting/fbs/list", []byte(`{}`))
		if err == nil || kind != "connect" || status != 0 || raw != nil || err.Error() != "redirect left loopback" {
			t.Fatalf("base %s status %d kind %s body %q err %v", base, status, kind, raw, err)
		}
	}
	t.Setenv("CLOUD_SELLER_BASE_URL", "https://api-seller.ozon.ru")
	status, _, kind, err := postDelegateSeller(context.Background(), sellerdomain.ResolveBaseURL(config.Load().SellerBaseURL()), "cid", "key", "/v1", []byte(`{}`))
	if err == nil || kind != "connect" || status != 0 {
		t.Fatalf("official status %d kind %s err %v", status, kind, err)
	}
	if second.Load() != 0 || sawCred.Load() || hits.Load() != 1 {
		t.Fatalf("second %d creds %v proxy %d", second.Load(), sawCred.Load(), hits.Load())
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
