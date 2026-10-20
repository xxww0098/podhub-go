package bench

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	"github.com/xxww0098/podhub-go/internal/platform/loadmode"
)

const (
	benchShops = 8
	benchDelay = time.Millisecond
)

// ozonTransport is the Seller transport this benchmark measures.
func ozonTransport() *http.Transport { return httpx.Ozon() }

func TestBenchAcceptsOnlyModeR(t *testing.T) {
	if err := loadmode.Run(loadmode.ModeR); err != nil {
		t.Fatal(err)
	}
	if err := loadmode.Run("W"); err == nil {
		t.Fatal("mode W was accepted")
	}
}

// TestRestrictedBaselineConcurrentConns records the pre-pool shape.
// Eight sequential requests reuse one TLS connection. Two concurrent
// waves of eight shops open more than eight connections: HTTP/1.1
// keeps only DefaultMaxIdleConnsPerHost idle connections per host.
func TestRestrictedBaselineConcurrentConns(t *testing.T) {
	if err := loadmode.Run(loadmode.ModeR); err != nil {
		t.Fatal(err)
	}
	const shops = benchShops
	srv := newSellerTLS(0)
	defer srv.Close()
	if !strings.HasPrefix(srv.URL, "https://127.0.0.1:") {
		t.Fatal(srv.URL)
	}
	ctx := context.Background()
	client := sellerShapedClient(srv, httpx.Restricted())

	seqAccepts := srv.accepts.Load()
	seq, err := sequential(ctx, client, srv.URL, shops)
	if err != nil {
		t.Fatal(err)
	}
	seqAccepts = srv.accepts.Load() - seqAccepts
	if seq.proto != "HTTP/1.1" || seqAccepts != 1 || seq.tls != 1 {
		t.Fatalf("sequential proto %s accepts %d tls %d", seq.proto, seqAccepts, seq.tls)
	}

	client = sellerShapedClient(srv, httpx.Restricted())
	before := srv.accepts.Load()
	var proto string
	var tlsN int64
	for waveN := 0; waveN < 2; waveN++ {
		if waveN > 0 {
			// Let the first wave's idle put finish so the per-host
			// idle limit closes the extra connections before the
			// next wave queues dials.
			time.Sleep(30 * time.Millisecond)
		}
		got, err := wave(ctx, client, srv.URL, shops)
		if err != nil {
			t.Fatal(err)
		}
		proto = got.proto
		tlsN += got.tls
	}
	accepts := srv.accepts.Load() - before
	if proto != "HTTP/1.1" {
		t.Fatalf("protocol %s", proto)
	}
	// One wave needs one TCP connection per in-flight request. The
	// second wave reuses at most the idle limit, so the server sees
	// more accepts than a single wave and at most two full waves.
	if accepts <= int64(shops) || accepts > int64(shops*2) {
		t.Fatalf("concurrent accepts %d tls %d shops %d idle-limit %d", accepts, tlsN, shops, http.DefaultMaxIdleConnsPerHost)
	}
	t.Logf("sequential accepts=%d tls=%d; concurrent shops=%d waves=2 accepts=%d tls=%d", seqAccepts, seq.tls, shops, accepts, tlsN)
}

func BenchmarkOzonSequentialDelay1ms(b *testing.B) {
	benchWave(b, 1, benchDelay)
}

func BenchmarkOzonConcurrent8Delay0(b *testing.B) {
	benchWave(b, benchShops, 0)
}

func BenchmarkOzonConcurrent8Delay1ms(b *testing.B) {
	benchWave(b, benchShops, benchDelay)
}

func benchWave(b *testing.B, shops int, delay time.Duration) {
	b.Helper()
	if err := loadmode.Run(loadmode.ModeR); err != nil {
		b.Fatal(err)
	}
	srv := newSellerTLS(delay)
	defer srv.Close()
	if !strings.HasPrefix(srv.URL, "https://127.0.0.1:") {
		b.Fatal(srv.URL)
	}
	client := sellerShapedClient(srv, ozonTransport())
	ctx := context.Background()
	if _, err := wave(ctx, client, srv.URL, shops); err != nil {
		b.Fatal(err)
	}
	srv.accepts.Store(0)
	samples := make([]time.Duration, 0, b.N)
	var tlsN atomic.Int64
	var proto string
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		start := time.Now()
		got, err := wave(ctx, client, srv.URL, shops)
		if err != nil {
			b.Fatal(err)
		}
		tlsN.Add(got.tls)
		proto = got.proto
		samples = append(samples, time.Since(start))
	}
	b.StopTimer()
	reqs := float64(shops * b.N)
	b.ReportMetric(float64(srv.accepts.Load())/reqs, "accepts/req")
	b.ReportMetric(float64(tlsN.Load())/reqs, "tls/req")
	b.ReportMetric(ms(percentile(samples, 0.50)), "p50/ms")
	b.ReportMetric(ms(percentile(samples, 0.95)), "p95/ms")
	b.Logf("protocol %s shops %d delay %s", proto, shops, delay)
}

type sellerServer struct {
	*httptest.Server
	accepts atomic.Int64
}

func newSellerTLS(delay time.Duration) *sellerServer {
	out := &sellerServer{}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if delay > 0 {
			time.Sleep(delay)
		}
		_, _ = io.Copy(io.Discard, r.Body)
		_ = r.Body.Close()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"items":[]}`))
	})
	srv := httptest.NewUnstartedServer(handler)
	srv.EnableHTTP2 = true
	srv.TLS = &tls.Config{NextProtos: []string{"h2", "http/1.1"}}
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			out.accepts.Add(1)
		}
	}
	srv.StartTLS()
	out.Server = srv
	return out
}

func certPool(srv *sellerServer) *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	return pool
}

// sellerShapedClient matches seller.Egress.New: 30s overall timeout, no
// redirect, no proxy. The TLS config trusts only the local server. The
// dial stays on 127.0.0.1. HTTP/2 is offered only when the transport
// already opted in with ForceAttemptHTTP2.
func sellerShapedClient(srv *sellerServer, tr *http.Transport) *http.Client {
	next := []string{"http/1.1"}
	if tr.ForceAttemptHTTP2 {
		next = []string{"h2", "http/1.1"}
	}
	clone := tr.Clone()
	clone.TLSClientConfig = &tls.Config{
		RootCAs:    certPool(srv),
		NextProtos: next,
		MinVersion: tls.VersionTLS12,
	}
	return &http.Client{
		Timeout:       30 * time.Second,
		Transport:     clone,
		CheckRedirect: httpx.UseLast,
	}
}

type connStat struct {
	tls   int64
	proto string
}

func sequential(ctx context.Context, client *http.Client, rawURL string, n int) (connStat, error) {
	var tlsN atomic.Int64
	var proto atomic.Value
	for i := 0; i < n; i++ {
		if err := one(ctx, client, rawURL, i, &tlsN, &proto); err != nil {
			return connStat{}, err
		}
	}
	got := connStat{tls: tlsN.Load()}
	if v, ok := proto.Load().(string); ok {
		got.proto = v
	}
	return got, nil
}

func wave(ctx context.Context, client *http.Client, rawURL string, shops int) (connStat, error) {
	var tlsN atomic.Int64
	var proto atomic.Value
	var wg sync.WaitGroup
	errCh := make(chan error, shops)
	for i := 0; i < shops; i++ {
		wg.Add(1)
		go func(shop int) {
			defer wg.Done()
			if err := one(ctx, client, rawURL, shop, &tlsN, &proto); err != nil {
				errCh <- err
			}
		}(i)
	}
	wg.Wait()
	close(errCh)
	got := connStat{tls: tlsN.Load()}
	if v, ok := proto.Load().(string); ok {
		got.proto = v
	}
	for err := range errCh {
		return got, err
	}
	return got, nil
}

func one(ctx context.Context, client *http.Client, rawURL string, shop int, tlsN *atomic.Int64, proto *atomic.Value) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL+"/v3/product/info/list", strings.NewReader(`{"offer_id":["shop"]}`))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Client-Id", "shop-"+itoa(shop))
	trace := &httptrace.ClientTrace{
		TLSHandshakeStart: func() { tlsN.Add(1) },
	}
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK || string(raw) != `{"items":[]}` {
		return errStatus{code: res.StatusCode, body: string(raw)}
	}
	proto.Store(res.Proto)
	return nil
}

type errStatus struct {
	code int
	body string
}

func (e errStatus) Error() string {
	return "status " + itoa(e.code) + " body " + e.body
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [16]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func percentile(samples []time.Duration, p float64) time.Duration {
	if len(samples) == 0 {
		return 0
	}
	sorted := append([]time.Duration(nil), samples...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	idx := int(math.Ceil(p*float64(len(sorted)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

func ms(d time.Duration) float64 {
	return float64(d.Microseconds()) / 1000
}
