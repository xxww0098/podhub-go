package ozon

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

	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
	"github.com/xxww0098/podhub-go/internal/seller/ozon/domain"
)

type officialRoundTrip func(*http.Request) (*http.Response, error)

func (fn officialRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }

func officialFixture(t *testing.T, handler http.HandlerFunc) *officialPort {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	port, err := newOfficialPort(StoreScope{OrgID: 7, StorePK: 11, StoreUUID: "550e8400-e29b-41d4-a716-446655440000", CredentialRevision: 3}, "fixture-client", "fixture-key", false)
	if err != nil {
		t.Fatal(err)
	}
	upstream, _ := url.Parse(srv.URL)
	local := &http.Transport{Proxy: nil}
	t.Cleanup(local.CloseIdleConnections)
	port.client = &http.Client{Timeout: time.Second, CheckRedirect: officialHTTPClient.CheckRedirect, Transport: officialRoundTrip(func(req *http.Request) (*http.Response, error) {
		if req.URL.Scheme != "https" || req.URL.Host != "api-seller.ozon.ru" {
			t.Errorf("unexpected origin %s", req.URL)
		}
		clone := req.Clone(req.Context())
		address := *req.URL
		address.Scheme, address.Host = upstream.Scheme, upstream.Host
		clone.URL = &address
		return local.RoundTrip(clone)
	})}
	return port
}

func TestOfficialBoundTransportHeadersPathsAndDefaults(t *testing.T) {
	var calls atomic.Int32
	port := officialFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.Header.Get("Client-Id") != "fixture-client" || r.Header.Get("Api-Key") != "fixture-key" {
			t.Error("missing bound credential headers")
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"items":[]}` {
			t.Errorf("body changed %s", body)
		}
		_, _ = io.WriteString(w, `{"result":{"task_id":71}}`)
	})
	if err := port.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	if status, _, err := port.Write(context.Background(), "/v3/product/import", []byte(`{"items":[]}`)); err != nil || status != 200 {
		t.Fatalf("write status %d err %v", status, err)
	}
	for _, path := range []string{"https://attacker.invalid", "//attacker.invalid/path", "/v3/product/import?x=1", "/v3/product/info/list/../import", "/v1/roles"} {
		if _, _, err := port.Read(context.Background(), path, []byte(`{}`)); !errors.Is(err, sellercontract.ErrNotSent) {
			t.Fatalf("read accepted path %q", path)
		}
		if _, _, err := port.Write(context.Background(), path, []byte(`{}`)); !errors.Is(err, sellercontract.ErrNotSent) {
			t.Fatalf("write accepted path %q", path)
		}
	}
	reader, err := NewOfficialReader(port.scope, "fixture-client", "fixture-key")
	if err != nil || !reader.WritesDisabled() || reader.Ready(context.Background()) == nil {
		t.Fatal("reader grants write authority")
	}
	if _, _, err := reader.Write(context.Background(), "/v3/product/import", []byte(`{}`)); !errors.Is(err, sellercontract.ErrNotSent) {
		t.Fatal("reader wrote")
	}
	if calls.Load() != 1 {
		t.Fatalf("requests %d", calls.Load())
	}
	if officialHTTPTransport.Proxy != nil || officialHTTPClient.Timeout != 30*time.Second || officialHTTPClient.CheckRedirect(nil, nil) != http.ErrUseLastResponse {
		t.Fatal("unsafe official client policy")
	}
	if _, err := dialOfficial(context.Background(), "tcp", "127.0.0.1:443"); !errors.Is(err, sellercontract.ErrNotSent) {
		t.Fatal("dialer accepted another origin")
	}
	if err := (&Egress{base: domain.ProductionBaseURL}).Port().Ready(context.Background()); !errors.Is(err, sellercontract.ErrNotSent) {
		t.Fatal("default Port opened production")
	}
}

func TestOfficialResponseLimitRedirectAndCancellation(t *testing.T) {
	var redirected atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
	defer other.Close()
	var oversize atomic.Bool
	port := officialFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if !oversize.Load() {
			w.Header().Set("Location", other.URL)
			w.WriteHeader(307)
			return
		}
		_, _ = io.WriteString(w, strings.Repeat(" ", (1<<20)+1))
	})
	if status, _, err := port.Read(context.Background(), "/v3/product/info/list", []byte(`{}`)); err != nil || status != 307 || redirected.Load() != 0 {
		t.Fatalf("redirect status=%d followed=%d err=%v", status, redirected.Load(), err)
	}
	oversize.Store(true)
	if status, body, err := port.Read(context.Background(), "/v3/product/info/list", []byte(`{}`)); status != 200 || body != "" || err == nil {
		t.Fatal("oversize response accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := port.Read(ctx, "/v3/product/info/list", []byte(`{}`)); err == nil {
		t.Fatal("cancellation ignored")
	}
}

func TestOfficialUsesBoundEgressLaneAndReadOnlyBinding(t *testing.T) {
	entered, leave := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	port := officialFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		close(entered)
		<-leave
		_, _ = io.WriteString(w, `{"items":[]}`)
	})
	e := &Egress{readSlots: filled(1), writeSlots: filled(1)}
	port.e = e
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _, _ = port.Read(context.Background(), "/v3/product/info/list", []byte(`{}`))
	}()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, _, err := port.Read(ctx, "/v3/product/info/list", []byte(`{}`)); err == nil || calls.Load() != 1 {
		t.Fatal("bound egress read lane bypassed")
	}
	close(leave)
	<-done
	if e.ReadPosts() != 1 {
		t.Fatalf("read statistics %d", e.ReadPosts())
	}
	factory := NewListingTransport(&Egress{base: domain.ProductionBaseURL}, func(ctx context.Context, scope sellercontract.StoreBinding) (StoreScope, string, string, error) {
		return port.scope, "fixture-client", "fixture-key", nil
	})
	bound, err := factory.BindStore(context.Background(), sellercontract.StoreBinding{OrgID: 7, StorePK: 11, StoreUUID: port.scope.StoreUUID, ReadOnly: true})
	if err != nil || !bound.WritesDisabled() {
		t.Fatal("read binding is writable")
	}
	if _, _, err := bound.Write(context.Background(), "/v3/product/import", []byte(`{}`)); !errors.Is(err, sellercontract.ErrNotSent) {
		t.Fatal("read binding sent a write")
	}
	if _, err := factory.BindStore(context.Background(), sellercontract.StoreBinding{OrgID: 8}); !errors.Is(err, sellercontract.ErrNotSent) {
		t.Fatal("cross-tenant binding accepted")
	}
}
