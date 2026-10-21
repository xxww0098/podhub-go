package bench

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	"github.com/xxww0098/podhub-go/internal/platform/loadmode"
)

// TestOzonReusesFewerConnectionsThanRestricted compares the steady state
// after one warm-up wave of eight shops. The warm-up is not counted.
// Restricted speaks HTTP/1.1 and keeps two idle connections, so the next
// waves handshake again. Ozon speaks HTTP/2 and keeps the warm-up
// connections, so those waves do not dial. Mode R is the only load-test
// mode, and the server is 127.0.0.1.
func TestOzonReusesFewerConnectionsThanRestricted(t *testing.T) {
	if err := loadmode.Run(loadmode.ModeR); err != nil {
		t.Fatal(err)
	}
	restricted := countWaveAccepts(t, httpx.Restricted())
	ozon := countWaveAccepts(t, httpx.Ozon())
	t.Logf("restricted accepts=%d tls=%d proto=%s; ozon accepts=%d tls=%d proto=%s",
		restricted.accepts, restricted.tls, restricted.proto, ozon.accepts, ozon.tls, ozon.proto)
	if restricted.proto != "HTTP/1.1" || restricted.accepts <= int64(benchShops) || restricted.accepts > int64(benchShops*2) {
		t.Fatalf("restricted baseline %+v", restricted)
	}
	// Accepts can include a connection the transport dialed and then discarded
	// before the handshake. TLSHandshakeStart is only recorded for a request
	// that actually negotiated, so a reused warm-up session stays at zero
	// handshakes even when that discarded dial is counted.
	if ozon.proto != "HTTP/2.0" || ozon.tls != 0 || ozon.accepts*4 >= restricted.accepts {
		t.Fatalf("ozon did not reuse %+v restricted %+v", ozon, restricted)
	}
}

type acceptStat struct {
	accepts int64
	tls     int64
	proto   string
}

func countWaveAccepts(t *testing.T, tr *http.Transport) acceptStat {
	t.Helper()
	srv := newSellerTLS(0)
	defer srv.Close()
	if !strings.HasPrefix(srv.URL, "https://127.0.0.1:") {
		t.Fatal(srv.URL)
	}
	client := sellerShapedClient(srv, tr)
	ctx := context.Background()
	if _, err := wave(ctx, client, srv, benchShops); err != nil {
		t.Fatal(err)
	}
	var proto string
	var tlsN int64
	before := srv.accepts.Load()
	for waveN := 0; waveN < 2; waveN++ {
		got, err := wave(ctx, client, srv, benchShops)
		if err != nil {
			t.Fatal(err)
		}
		proto = got.proto
		tlsN += got.tls
	}
	return acceptStat{accepts: srv.accepts.Load() - before, tls: tlsN, proto: proto}
}
