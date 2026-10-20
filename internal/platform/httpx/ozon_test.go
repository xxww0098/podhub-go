package httpx

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestOzonTransportShape(t *testing.T) {
	tr := Ozon()
	if Ozon() != tr {
		t.Fatal("ozon transport is not process-wide")
	}
	if tr == Restricted() || tr == Plain() || tr == Loopback(false) || tr == Loopback(true) {
		t.Fatal("ozon transport aliased another bucket")
	}
	if tr.Proxy != nil {
		t.Fatal("ozon proxy is set")
	}
	if !tr.ForceAttemptHTTP2 {
		t.Fatal("ozon does not attempt HTTP/2")
	}
	if tr.MaxIdleConns != 128 || tr.MaxIdleConnsPerHost != 128 || tr.MaxConnsPerHost != 0 {
		t.Fatalf("pool idle=%d perHost=%d max=%d", tr.MaxIdleConns, tr.MaxIdleConnsPerHost, tr.MaxConnsPerHost)
	}
	if tr.IdleConnTimeout != 90*time.Second || tr.TLSHandshakeTimeout != 10*time.Second ||
		tr.ResponseHeaderTimeout != 30*time.Second || tr.ExpectContinueTimeout != time.Second {
		t.Fatalf("timeouts idle=%s handshake=%s header=%s expect=%s",
			tr.IdleConnTimeout, tr.TLSHandshakeTimeout, tr.ResponseHeaderTimeout, tr.ExpectContinueTimeout)
	}
	client := OzonClient()
	if client.Timeout != 0 {
		t.Fatalf("ozon client timeout %s", client.Timeout)
	}
	if Base(client.Transport) != tr {
		t.Fatal("ozon client is not on Ozon")
	}
	if err := client.CheckRedirect(nil, nil); !errors.Is(err, http.ErrUseLastResponse) {
		t.Fatal(err)
	}
	if _, err := tr.DialContext(context.Background(), "tcp", "1.2.3.4:80"); !errors.Is(err, ErrNotLoopback) {
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

func TestOzonRefusesProxyRedirectAndPublicDial(t *testing.T) {
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

	parsed, err := url.Parse(proxy.URL)
	if err != nil {
		t.Fatal(err)
	}
	control, err := http.NewRequest(http.MethodGet, "http://example.com/models", nil)
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

	client := OzonClient()
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
		raw, err := ReadLimit(res.Body, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
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
	if second.Load() != 0 || sawCred.Load() || proxyHits.Load() != 1 {
		t.Fatalf("second %d creds %v proxy %d", second.Load(), sawCred.Load(), proxyHits.Load())
	}
}

func TestReadLimitPrefixMatchesLimitReader(t *testing.T) {
	payload := bytes.Repeat([]byte("ab"), 1<<20)
	got, err := ReadLimit(io.NopCloser(bytes.NewReader(payload)), 1<<20)
	if err != nil || !bytes.Equal(got, payload[:1<<20]) {
		t.Fatalf("len %d err %v", len(got), err)
	}
	got, err = ReadLimit(io.NopCloser(strings.NewReader("stay")), 1<<20)
	if err != nil || string(got) != "stay" {
		t.Fatalf("short %q %v", got, err)
	}
	got, err = ReadLimit(io.NopCloser(strings.NewReader("all")), 0)
	if err != nil || string(got) != "all" {
		t.Fatalf("unlimited %q %v", got, err)
	}
	got, err = ReadLimit(nil, 1)
	if err != nil || got != nil {
		t.Fatalf("nil %q %v", got, err)
	}
	Discard(nil)
}

func TestReadLimitDrainsForReuse(t *testing.T) {
	var accepts atomic.Int64
	big := bytes.Repeat([]byte("x"), (1<<20)+8)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = w.Write(big)
	}))
	srv.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			accepts.Add(1)
		}
	}
	srv.Start()
	t.Cleanup(srv.Close)
	client := OzonClient()
	client.Timeout = 5 * time.Second
	for i := 0; i < 2; i++ {
		req, err := http.NewRequest(http.MethodPost, srv.URL+"/v3/product/info/list", strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := ReadLimit(res.Body, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(raw, big[:1<<20]) {
			t.Fatalf("prefix len %d", len(raw))
		}
	}
	if accepts.Load() != 1 {
		t.Fatalf("accepts %d", accepts.Load())
	}
}

func TestOzonTLSReusesOneHTTP2Connection(t *testing.T) {
	var accepts atomic.Int64
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"items":[]}`))
	}))
	srv.EnableHTTP2 = true
	srv.TLS = &tls.Config{NextProtos: []string{"h2", "http/1.1"}}
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			accepts.Add(1)
		}
	}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	tr := Ozon().Clone()
	tr.TLSClientConfig = &tls.Config{
		RootCAs:    pool,
		NextProtos: []string{"h2", "http/1.1"},
		MinVersion: tls.VersionTLS12,
	}
	client := &http.Client{Timeout: 5 * time.Second, Transport: tr, CheckRedirect: UseLast}
	var proto string
	for i := 0; i < 8; i++ {
		req, err := http.NewRequest(http.MethodPost, srv.URL+"/v3/product/info/list", strings.NewReader(`{"offer_id":["a"]}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Client-Id", "cid")
		req.Header.Set("Api-Key", "key")
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := ReadLimit(res.Body, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK || string(raw) != `{"items":[]}` {
			t.Fatalf("status %d body %q", res.StatusCode, raw)
		}
		if res.Header.Get("Content-Type") != "application/json" {
			t.Fatal(res.Header.Get("Content-Type"))
		}
		proto = res.Proto
	}
	if proto != "HTTP/2.0" || accepts.Load() != 1 {
		t.Fatalf("proto %s accepts %d", proto, accepts.Load())
	}
}
