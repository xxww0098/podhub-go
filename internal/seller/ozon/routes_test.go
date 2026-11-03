package ozon

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	admindomain "github.com/xxww0098/podhub-go/internal/admin/domain"
	adminsvc "github.com/xxww0098/podhub-go/internal/admin/service"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
)

func routeCertificate(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "api-seller.ozon.ru"}, DNSNames: []string{"api-seller.ozon.ru"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, roots
}

func routeTarget(t *testing.T, certificate tls.Certificate, node string, hits, imports, status *atomic.Int32) string {
	t.Helper()
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Host != "api-seller.ozon.ru" || r.TLS.ServerName != "api-seller.ozon.ru" {
			t.Error("Seller host or TLS name changed")
		}
		if r.URL.Path == "/v1/roles" {
			if r.Header.Get("Api-Key") != "" || r.Header.Get("Client-Id") != "" {
				t.Error("relay probe sent shop credentials")
			}
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Header.Get("Api-Key") != "fixture-key" || r.Header.Get("Client-Id") != "fixture-client" {
			t.Error("shop credential missing from tunneled Seller read")
		}
		if r.URL.Path == "/v3/product/import" {
			raw, err := io.ReadAll(r.Body)
			if err != nil || !json.Valid(raw) {
				t.Error("import body was not fully received")
			}
			imports.Add(1)
			if node == "b" {
				conn, _, err := w.(http.Hijacker).Hijack()
				if err == nil {
					_ = conn.Close()
				}
				return
			}
		}
		if status.Load() != 0 {
			w.Header().Set("Location", "https://attacker.invalid/")
			w.WriteHeader(int(status.Load()))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"node": node})
	}))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv.Listener.Addr().String()
}

func routeSOCKS(t *testing.T, target func() string, mode, connects *atomic.Int32) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var clients []net.Conn
	t.Cleanup(func() {
		_ = l.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, c := range clients {
			_ = c.Close()
		}
	})
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			clients = append(clients, c)
			mu.Unlock()
			go func() {
				defer c.Close()
				_ = c.SetDeadline(time.Now().Add(5 * time.Second))
				var hello [3]byte
				if _, err := io.ReadFull(c, hello[:]); err != nil || hello != [3]byte{5, 1, 0} {
					return
				}
				_, _ = c.Write([]byte{5, 0})
				var head [5]byte
				if _, err := io.ReadFull(c, head[:]); err != nil || head[0] != 5 || head[1] != 1 || head[2] != 0 || head[3] != 3 {
					return
				}
				name := make([]byte, int(head[4])+2)
				if _, err := io.ReadFull(c, name); err != nil {
					return
				}
				if string(name[:len(name)-2]) != "api-seller.ozon.ru" || binary.BigEndian.Uint16(name[len(name)-2:]) != 443 {
					t.Error("SOCKS destination escaped fixed official hostname")
					return
				}
				connects.Add(1)
				if mode.Load() == 1 {
					_, _ = c.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
					return
				}
				if mode.Load() == 2 {
					_, _ = io.Copy(io.Discard, c)
					return
				}
				upstream, err := net.DialTimeout("tcp", target(), time.Second)
				if err != nil {
					return
				}
				defer upstream.Close()
				_, _ = c.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
				if mode.Load() == 3 {
					return
				}
				_ = c.SetDeadline(time.Time{})
				go func() { _, _ = io.Copy(upstream, c); _ = upstream.Close() }()
				_, _ = io.Copy(c, upstream)
			}()
		}
	}()
	return "socks5h://" + l.Addr().String()
}

func TestRelaySelectionChangesActualSellerTLSPath(t *testing.T) {
	certificate, roots := routeCertificate(t)
	var aHits, bHits, directHits, aImports, bImports, directImports, status, mode, connects atomic.Int32
	a := routeTarget(t, certificate, "a", &aHits, &aImports, &status)
	b := routeTarget(t, certificate, "b", &bHits, &bImports, &status)
	direct := routeTarget(t, certificate, "direct", &directHits, &directImports, &status)
	dir, switchDir := t.TempDir(), t.TempDir()
	route := routeSOCKS(t, func() string {
		raw, _ := os.ReadFile(filepath.Join(dir, "config.json"))
		var cfg struct{ Outbounds []struct{ Server string } }
		_ = json.Unmarshal(raw, &cfg)
		if len(cfg.Outbounds) == 1 && cfg.Outbounds[0].Server == "node-b.invalid" {
			return b
		}
		return a
	}, &mode, &connects)
	base := officialHTTPTransport.Clone()
	base.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	base.DialContext = func(ctx context.Context, network, target string) (net.Conn, error) {
		if target != "api-seller.ozon.ru:443" {
			return nil, errOfficialRequest
		}
		return (&net.Dialer{}).DialContext(ctx, network, direct)
	}
	previous := officialHTTPTransport
	officialHTTPTransport = base
	t.Cleanup(func() { officialHTTPTransport = previous; base.CloseIdleConnections() })
	t.Setenv("CLOUD_SELLER_EGRESS_ROUTES", route+",direct")
	t.Setenv("CLOUD_SELLER_RELAY_DIR", dir)
	t.Setenv("CLOUD_SELLER_RELAY_SWITCH_DIR", switchDir)
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	e := New(config.Load())
	router := e.official.Transport.(*officialRoutes)
	t.Cleanup(router.CloseIdleConnections)
	read := func(want string) {
		t.Helper()
		reply, err := e.SellerReadCall(context.Background(), "POST", "/v3/product/info/list", []byte(`{}`), false, true, "fixture-client", "fixture-key")
		if err != nil || reply.Status != 200 || !strings.Contains(reply.Body, `"node":"`+want+`"`) {
			t.Fatalf("want node %s: status=%d body=%s err=%v", want, reply.Status, reply.Body, err)
		}
	}
	svc := adminsvc.NewRelay(nil, adminsvc.RelayOptions{Dir: dir, SwitchDir: switchDir, Route: route, Probe: func(ctx context.Context, route string) error { return ProbeRelay(ctx, route, dir, switchDir) }})
	link := func(host string) string {
		return "vless://550e8400-e29b-41d4-a716-446655440000@" + host + ":443?security=reality&sni=cover.invalid&pbk=" + strings.Repeat("A", 43)
	}
	raw, _ := json.Marshal(map[string]string{"links": link("node-a.invalid") + "\n" + link("node-b.invalid")})
	view, err := svc.Import(context.Background(), admindomain.Actor{}, raw)
	if err != nil || len(view.Data.Nodes) != 2 {
		t.Fatal("node import failed", err)
	}
	activate := func(id *string) {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"nodeId": id})
		if _, err := svc.Switch(context.Background(), admindomain.Actor{}, raw); err != nil {
			t.Fatal(err)
		}
	}
	ready := func() {
		t.Helper()
		if err := os.WriteFile(filepath.Join(switchDir, "active"), []byte("ready"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	read("direct")
	activate(&view.Data.Nodes[0].ID)
	read("direct")
	if probe, _ := svc.Probe(context.Background()); probe.Data.Reachable {
		t.Fatal("pending sidecar was declared reachable via direct fallback")
	}
	ready()
	read("a")
	read("a")
	if connects.Load() != 1 {
		t.Fatal("selected proxy did not reuse its connection")
	}
	activate(&view.Data.Nodes[1].ID)
	read("direct")
	ready()
	read("b")
	if connects.Load() != 2 || aHits.Load() != 2 || bHits.Load() != 1 {
		t.Fatal("node switch reused an old tunnel")
	}
	if probe, err := svc.Probe(context.Background()); err != nil || !probe.Data.Reachable || probe.Data.LatencyMs == nil {
		t.Fatal("working TLS proxy was not reachable", err)
	}
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	open := New(config.Load())
	scope := StoreScope{OrgID: 7, StorePK: 11, StoreUUID: "550e8400-e29b-41d4-a716-446655440000", CredentialRevision: 1}
	bound, err := NewListingTransport(open, func(context.Context, sellercontract.StoreBinding) (StoreScope, string, string, error) {
		return scope, "fixture-client", "fixture-key", nil
	}).BindStore(context.Background(), sellercontract.StoreBinding{OrgID: 7, StorePK: 11, StoreUUID: scope.StoreUUID})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := bound.Write(context.Background(), "/v3/product/import", []byte(`{"items":[]}`)); err == nil || errors.Is(err, sellercontract.ErrNotSent) || bImports.Load() != 1 || directImports.Load() != 0 || open.WritePosts() != 1 {
		t.Fatal("accepted import with lost response was resent or reported not sent")
	}
	before := connects.Load()
	if _, err := e.Call(context.Background(), "POST", "/v3/product/info/list", []byte(`{}`), false, true, "fixture-client", "fixture-key"); !errors.Is(err, ErrRefusedOrigin) {
		t.Fatal("generic write/read egress was opened")
	}
	if _, err := e.ProductPriceCall(context.Background(), "POST", "/v1/product/import/prices", []byte(`{}`), true, true, "fixture-client", "fixture-key"); !errors.Is(err, sellercontract.ErrWritesDisabled) || connects.Load() != before {
		t.Fatal("write kill switch was bypassed")
	}
	for _, address := range []string{"https://attacker.invalid/", "http://api-seller.ozon.ru/", "https://api-seller.ozon.ru:444/"} {
		req, _ := http.NewRequest("GET", address, nil)
		if _, err := router.RoundTrip(req); err == nil || connects.Load() != before {
			t.Fatal("routing opened another destination")
		}
	}
	status.Store(http.StatusTemporaryRedirect)
	directBefore := directHits.Load()
	if reply, err := e.SellerReadCall(context.Background(), "GET", "/v1/actions", nil, false, true, "fixture-client", "fixture-key"); err != nil || reply.Status != 307 || directHits.Load() != directBefore {
		t.Fatal("redirect escaped proxy or was retried")
	}
	status.Store(http.StatusServiceUnavailable)
	bBefore := bHits.Load()
	if reply, err := e.SellerReadCall(context.Background(), "POST", "/v3/product/info/list", []byte(`{}`), false, true, "fixture-client", "fixture-key"); err != nil || reply.Status != 503 || bHits.Load() != bBefore+1 || directHits.Load() != directBefore {
		t.Fatal("an HTTP response was retried through another route")
	}
	status.Store(0)
	router.CloseIdleConnections()
	mode.Store(1)
	read("direct")
	if probe, _ := svc.Probe(context.Background()); probe.Data.Reachable {
		t.Fatal("failed proxy probe succeeded by going direct")
	}
	mode.Store(0)
	router.mu.Lock()
	router.retryAt = time.Now().Add(-time.Second)
	router.mu.Unlock()
	read("b")
	if directHits.Load() != directBefore+1 {
		t.Fatal("direct fallback stayed sticky after proxy recovery")
	}
	router.CloseIdleConnections()
	mode.Store(3)
	directBefore = directHits.Load()
	if _, err := e.SellerReadCall(context.Background(), "POST", "/v3/product/info/list", []byte(`{}`), false, true, "fixture-client", "fixture-key"); err == nil || directHits.Load() != directBefore {
		t.Fatal("TLS failure after tunnel establishment triggered an HTTP retry")
	}
	mode.Store(0)
	router.CloseIdleConnections()
	mode.Store(2)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := e.SellerReadCall(ctx, "POST", "/v3/product/info/list", []byte(`{}`), false, true, "fixture-client", "fixture-key"); err == nil {
		t.Fatal("hung proxy ignored deadline")
	}
	mode.Store(0)
	activate(nil)
	read("direct")
	if probe, _ := svc.Probe(context.Background()); probe.Data.Reachable {
		t.Fatal("disabled relay reported reachable")
	}
	t.Setenv("CLOUD_SELLER_EGRESS_ROUTES", route)
	strict := New(config.Load())
	if reply, err := strict.SellerReadCall(context.Background(), "POST", "/v3/product/info/list", []byte(`{}`), false, true, "fixture-client", "fixture-key"); err == nil || reply.Status != 0 {
		t.Fatal("proxy-only policy silently enabled direct after disable")
	}
}

func TestSellerRoutesRejectInvalidConfigurationAndBenchmarkIPs(t *testing.T) {
	t.Setenv("CLOUD_SELLER_EGRESS_ROUTES", "https://untrusted.invalid")
	e := New(config.Load())
	if reply, err := e.SellerReadCall(context.Background(), "POST", "/v3/product/list", []byte(`{}`), false, true, "fixture-client", "fixture-key"); err == nil || reply.Status != 0 {
		t.Fatal("invalid proxy configuration silently became direct")
	}
	for _, raw := range []string{"198.18.0.1", "198.19.255.255", "::ffff:198.18.0.1"} {
		if !ipBenchmarks(net.ParseIP(raw)) {
			t.Fatal("benchmark/fakeDNS address was not rejected")
		}
	}
	if ipBenchmarks(net.ParseIP("185.73.194.77")) {
		t.Fatal("public address rejected as benchmark")
	}
}
