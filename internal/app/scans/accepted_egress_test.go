package scans

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	sellerdomain "github.com/xxww0098/podhub-go/internal/seller/domain"
)

func TestPostInfoListBytesMatchPlain(t *testing.T) {
	const payload = `{"items":[{"id":7,"offer_id":"OFFER1","sources":[{"sku":8}]}]}`
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
	if httpx.Base(infoListClient.Transport) != httpx.Ozon() || httpx.Ozon() == httpx.Restricted() {
		t.Fatal("accepted scan is not on the ozon client")
	}
	body := []byte(`{"offer_id":["OFFER1"]}`)
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/v3/product/info/list", strings.NewReader(string(body)))
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
	status, raw, err := postInfoList(context.Background(), srv.URL, "cid", "key", body)
	if err != nil || status != res.StatusCode || string(raw) != string(oldRaw) || seen != oldSeen {
		t.Fatalf("status %d/%d body %q/%q seen %q/%q err %v", status, res.StatusCode, raw, oldRaw, seen, oldSeen, err)
	}
	found, ok := parseAccepted(status, raw, err)
	if !ok || found["OFFER1"].ProductID != 7 || found["OFFER1"].SKU != 8 {
		t.Fatalf("parse %+v %v", found, ok)
	}
}

func TestPostInfoListSkipsRedirectAndProxy(t *testing.T) {
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
	status, raw, err := postInfoList(context.Background(), hop307.URL, "cid", "key", []byte(`{"offer_id":["a"]}`))
	if err != nil || status != http.StatusTemporaryRedirect || string(raw) != "stay" {
		t.Fatalf("307 status %d body %q err %v", status, raw, err)
	}
	status, raw, err = postInfoList(context.Background(), hop308.URL, "cid", "key", []byte(`{"offer_id":["a"]}`))
	if err != nil || status != http.StatusPermanentRedirect || string(raw) != "stay" {
		t.Fatalf("308 status %d body %q err %v", status, raw, err)
	}
	if _, _, err := postInfoList(context.Background(), sellerdomain.ProductionBaseURL, "cid", "key", []byte(`{}`)); err == nil || !errors.Is(err, httpx.ErrNotLoopback) {
		t.Fatalf("official host %v", err)
	}
	if second.Load() != 0 || sawCred.Load() || hits.Load() != 1 {
		t.Fatalf("second %d creds %v proxy %d", second.Load(), sawCred.Load(), hits.Load())
	}
	if _, ok := parseAccepted(http.StatusTemporaryRedirect, []byte("stay"), nil); ok {
		t.Fatal("redirect parsed as a catalogue hit")
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
