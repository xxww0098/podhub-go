package storehttp

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"

	"github.com/xxww0098/podhub-go/internal/store/domain"
)

type thumbnailRoundTripFunc func(*http.Request) (*http.Response, error)

func (f thumbnailRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestThumbnailPublicAddress(t *testing.T) {
	for _, raw := range []string{
		"127.0.0.1", "::1", "::ffff:127.0.0.1", "10.0.0.1", "192.168.1.1", "fc00::1",
		"169.254.169.254", "100.64.0.1", "198.18.0.1", "192.0.2.1", "198.51.100.1",
		"203.0.113.1", "240.0.0.1", "2001:db8::1", "64:ff9b::7f00:1",
	} {
		if publicThumbnailIP(netip.MustParseAddr(raw)) {
			t.Errorf("accepted non-public address %s", raw)
		}
	}
	for _, raw := range []string{"8.8.8.8", "2606:4700:4700::1111"} {
		if !publicThumbnailIP(netip.MustParseAddr(raw)) {
			t.Errorf("rejected public address %s", raw)
		}
	}
}

func TestThumbnailDialChecksHostDNSAndPinsAddress(t *testing.T) {
	ctx := context.Background()
	for _, address := range []string{"evil.invalid:443", "ozon.ru.evil.invalid:443", "127.0.0.1:443", "images.ozon.ru:80", "images.ozon.ru:444"} {
		lookedUp := false
		_, err := dialThumbnailWith(ctx, "tcp", address,
			func(context.Context, string, string) ([]netip.Addr, error) { lookedUp = true; return nil, nil },
			func(context.Context, string, string) (net.Conn, error) { t.Fatal("unexpected dial"); return nil, nil })
		if err == nil || lookedUp {
			t.Fatalf("unsafe address %s: err=%v lookedUp=%v", address, err, lookedUp)
		}
	}
	for _, ips := range [][]netip.Addr{
		{netip.MustParseAddr("127.0.0.1")},
		{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("10.0.0.1")},
		{netip.MustParseAddr("198.18.0.1")},
	} {
		dialed := false
		_, err := dialThumbnailWith(ctx, "tcp", "images.ozon.ru:443",
			func(context.Context, string, string) ([]netip.Addr, error) { return ips, nil },
			func(context.Context, string, string) (net.Conn, error) {
				dialed = true
				return nil, errors.New("unexpected")
			})
		if err == nil || dialed {
			t.Fatalf("unsafe DNS answer accepted: err=%v dialed=%v", err, dialed)
		}
	}
	lookups, dials := 0, 0
	conn, err := dialThumbnailWith(ctx, "tcp", "images.ozon.ru:443",
		func(_ context.Context, network, host string) ([]netip.Addr, error) {
			lookups++
			if network != "ip" || host != "images.ozon.ru" {
				t.Fatalf("lookup %s %s", network, host)
			}
			return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
		},
		func(_ context.Context, network, address string) (net.Conn, error) {
			dials++
			if network != "tcp" || address != "8.8.8.8:443" {
				t.Fatalf("un-pinned dial %s %s", network, address)
			}
			client, peer := net.Pipe()
			peer.Close()
			return client, nil
		})
	if err != nil || lookups != 1 || dials != 1 {
		t.Fatalf("conn=%v lookups=%d dials=%d err=%v", conn != nil, lookups, dials, err)
	}
	conn.Close()
}

func TestThumbnailRedirectsStayOnOzonHTTPS(t *testing.T) {
	const source = "https://images.ozon.ru/start"
	for _, tc := range []struct {
		location string
		allowed  bool
	}{
		{"/next", true}, {"https://cdn.ozone.ru/next", true},
		{"https://evil.invalid/next", false}, {"//ozon.ru.evil.invalid/next", false},
		{"http://images.ozon.ru/next", false}, {"https://images.ozon.ru:444/next", false},
		{"https://user@images.ozon.ru/next", false},
	} {
		_, ok := domain.NextImageHop(source, tc.location)
		if ok != tc.allowed {
			t.Errorf("redirect %q: got %v", tc.location, ok)
		}
	}
	if err := thumbnailClient.CheckRedirect(&http.Request{}, nil); !errors.Is(err, http.ErrUseLastResponse) {
		t.Fatalf("client follows redirects: %v", err)
	}
}

func TestServeThumbnailFollowsOnlyValidatedRedirects(t *testing.T) {
	for _, tc := range []struct {
		name     string
		location string
		wantCode int
		calls    int
	}{
		{"valid CDN redirect", "https://cdn.ozone.ru/next", http.StatusOK, 2},
		{"external redirect", "https://evil.invalid/next", http.StatusBadGateway, 1},
		{"private address redirect", "https://127.0.0.1/next", http.StatusBadGateway, 1},
		{"nonstandard port redirect", "https://images.ozon.ru:444/next", http.StatusBadGateway, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			client := &http.Client{CheckRedirect: thumbnailClient.CheckRedirect, Transport: thumbnailRoundTripFunc(func(req *http.Request) (*http.Response, error) {
				calls++
				if calls == 1 {
					return &http.Response{StatusCode: http.StatusFound, Header: http.Header{"Location": {tc.location}}, Body: io.NopCloser(bytes.NewReader(nil))}, nil
				}
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader([]byte{0xff, 0xd8, 0xff, 0x00}))}, nil
			})}
			rec := httptest.NewRecorder()
			handler{}.serveImage(rec, httptest.NewRequest(http.MethodGet, "/", nil), "https://images.ozon.ru/start", client)
			if rec.Code != tc.wantCode || calls != tc.calls {
				t.Fatalf("status=%d calls=%d", rec.Code, calls)
			}
			if tc.wantCode == http.StatusOK && rec.Header().Get("Content-Type") != "image/jpeg" {
				t.Fatalf("image content type = %q", rec.Header().Get("Content-Type"))
			}
		})
	}
}

func TestFetchThumbnailRejectsUnsafeOriginAndInvalidImage(t *testing.T) {
	for _, raw := range []string{"https://evil.invalid/a", "https://ozon.ru.evil.invalid/a", "https://127.0.0.1/a", "https://images.ozon.ru:444/a", "https://user@images.ozon.ru/a"} {
		client := &http.Client{Transport: thumbnailRoundTripFunc(func(*http.Request) (*http.Response, error) {
			t.Fatal("unsafe origin was requested")
			return nil, nil
		})}
		if _, _, err := fetchOzonThumbnail(context.Background(), raw, client); err == nil {
			t.Fatalf("unsafe origin %q accepted", raw)
		}
	}
	for _, raw := range [][]byte{[]byte("not an image"), append([]byte{0xff, 0xd8, 0xff}, make([]byte, maxImageBytes)...)} {
		client := &http.Client{Transport: thumbnailRoundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(raw))}, nil
		})}
		if _, _, err := fetchOzonThumbnail(context.Background(), "https://images.ozon.ru/a", client); err == nil {
			t.Fatal("invalid image response accepted")
		}
	}
}
