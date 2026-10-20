package seller

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

	"github.com/xxww0098/podhub-go/internal/platform/config"
	ozon "github.com/xxww0098/podhub-go/internal/platform/egressgate"
	"github.com/xxww0098/podhub-go/internal/platform/httpx"
)

func TestKillSwitchSendsNoWriteAndStillReads(t *testing.T) {
	var writes, reads atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v3/product/import" {
			writes.Add(1)
		} else {
			reads.Add(1)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"items":[]}`))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	eg := New(config.Load())
	if _, err := eg.Write(context.Background(), "/v3/product/import", []byte(`{}`)); err != ozon.ErrWritesDisabled {
		t.Fatalf("write %v", err)
	}
	reply, err := eg.Read(context.Background(), "/v3/product/info/list", []byte(`{"offer_id":["a"]}`))
	if err != nil || reply.Status != http.StatusOK {
		t.Fatalf("read %v %+v", err, reply)
	}
	if writes.Load() != 0 || reads.Load() != 1 || eg.WritePosts() != 0 || eg.ReadPosts() != 1 {
		t.Fatalf("writes %d reads %d egress %d/%d", writes.Load(), reads.Load(), eg.WritePosts(), eg.ReadPosts())
	}
}

func TestNonLoopbackNeverDials(t *testing.T) {
	t.Setenv("CLOUD_SELLER_BASE_URL", "https://api-seller.ozon.ru")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	eg := New(config.Load())
	if _, err := eg.Write(context.Background(), "/v3/product/import", []byte(`{}`)); err != ErrRefusedOrigin {
		t.Fatalf("%v", err)
	}
	if eg.WritePosts() != 0 {
		t.Fatal(eg.WritePosts())
	}
}

func TestLoopbackWriteIsCounted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"result":{"task_id":7}}`))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	eg := New(config.Load())
	reply, err := eg.Write(context.Background(), "/v3/product/import", []byte(`{"items":[]}`))
	if err != nil || reply.Status != 200 || eg.WritePosts() != 1 {
		t.Fatalf("%v %+v posts %d", err, reply, eg.WritePosts())
	}
}

func TestKillSwitchReadForwardMatchesOldClient(t *testing.T) {
	const payload = `{"items":[{"offer_id":"a"}]}`
	type seen struct{ method, path, ct, cid, key, body string }
	var last seen
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		last = seen{r.Method, r.URL.Path, r.Header.Get("Content-Type"), r.Header.Get("Client-Id"), r.Header.Get("Api-Key"), string(raw)}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(payload))
	}))
	t.Cleanup(srv.Close)
	clearProxyEnv(t)
	t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	old := func(path, body, cid, key string) (int, string, seen) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, srv.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		if cid != "" {
			req.Header.Set("Client-Id", cid)
		}
		if key != "" {
			req.Header.Set("Api-Key", key)
		}
		res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, string(raw), last
	}
	eg := New(config.Load())
	if httpx.Base(eg.client.Transport) != httpx.Ozon() || httpx.Ozon() == httpx.Restricted() {
		t.Fatal("egress is not on the ozon transport")
	}
	if err := eg.client.CheckRedirect(nil, nil); !errors.Is(err, http.ErrUseLastResponse) {
		t.Fatal(err)
	}
	if _, err := eg.Write(context.Background(), "/v3/product/import", []byte(`{}`)); err != ozon.ErrWritesDisabled || eg.WritePosts() != 0 {
		t.Fatalf("write %v posts %d", err, eg.WritePosts())
	}
	body := `{"offer_id":["a"]}`
	oldStatus, oldBody, oldSeen := old("/v3/product/info/list", body, "", "")
	reply, err := eg.Read(context.Background(), "/v3/product/info/list", []byte(body))
	if err != nil || reply.Status != oldStatus || reply.Body != oldBody || last != oldSeen {
		t.Fatalf("read %v status %d/%d body %q/%q seen %+v vs %+v", err, reply.Status, oldStatus, reply.Body, oldBody, last, oldSeen)
	}
	oldStatus, oldBody, oldSeen = old("/v3/product/info/list?lang=zh", body, "cid", "key")
	fwd, err := eg.Forward(context.Background(), http.MethodPost, "/v3/product/info/list", "lang=zh", "application/json", []byte(body), "cid", "key")
	if err != nil || fwd.Status != oldStatus || fwd.Body != oldBody {
		t.Fatalf("forward %v status %d/%d body %q/%q", err, fwd.Status, oldStatus, fwd.Body, oldBody)
	}
	if last.method != oldSeen.method || last.ct != oldSeen.ct || last.cid != "cid" || last.key != "key" || last.body != oldSeen.body || last.path != oldSeen.path {
		t.Fatalf("forward request %+v vs %+v", last, oldSeen)
	}
}

func TestReadForwardSkipRedirectAndProxy(t *testing.T) {
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
		if strings.Contains(r.URL.Path, "308") {
			code = http.StatusPermanentRedirect
		}
		w.Header().Set("Location", next.URL+"/landed")
		w.WriteHeader(code)
		_, _ = w.Write([]byte("stay"))
	}))
	t.Cleanup(first.Close)
	proxyHits := serveProxy(t)
	t.Setenv("CLOUD_SELLER_BASE_URL", first.URL+"/")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	if proxyHits.Load() != 1 {
		t.Fatalf("proxy control %d", proxyHits.Load())
	}
	eg := New(config.Load())
	reply, err := eg.Read(context.Background(), "/307", []byte(`{"a":1}`))
	if err != nil || reply.Status != http.StatusTemporaryRedirect || reply.Body != "stay" {
		t.Fatalf("read %v %+v", err, reply)
	}
	fwd, err := eg.Forward(context.Background(), http.MethodPost, "/308", "", "application/json", []byte(`{"a":1}`), "cid", "key")
	if err != nil || fwd.Status != http.StatusPermanentRedirect || fwd.Body != "stay" {
		t.Fatalf("forward %v %+v", err, fwd)
	}
	if _, err := eg.Write(context.Background(), "/v3/product/import", []byte(`{}`)); err != ozon.ErrWritesDisabled {
		t.Fatal(err)
	}
	if second.Load() != 0 || sawCred.Load() || proxyHits.Load() != 1 {
		t.Fatalf("second %d creds %v proxy %d", second.Load(), sawCred.Load(), proxyHits.Load())
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
	// ProxyFromEnvironment caches the process environment on first use, so the
	// control sets the proxy explicitly. HTTP_PROXY is still set above: a
	// client that consults it would also reach this server when the cache
	// has not been filled yet.
	res, err := (&http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{
		Proxy: func(*http.Request) (*url.URL, error) { return parsed, nil },
	}}).Do(req)
	if err != nil || res.StatusCode != 599 {
		t.Fatalf("proxy control %v", err)
	}
	res.Body.Close()
	return &hits
}
