package storehttp

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// Thumbnail requests get their own transport: only Ozon CDN hosts and public
// DNS answers are allowed, and the checked address is the one dialed.
var thumbnailClient = &http.Client{
	CheckRedirect: httpx.UseLast,
	Transport: &http.Transport{
		Proxy:                 nil,
		DialContext:           dialThumbnail,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
	},
}

// FetchOzonThumbnail reads an Ozon CDN image for either product view.
// Its fixed transport validates every destination and never forwards credentials.
func FetchOzonThumbnail(ctx context.Context, rawURL string) (int, []byte, error) {
	return fetchOzonThumbnail(ctx, rawURL, thumbnailClient)
}

func fetchOzonThumbnail(ctx context.Context, rawURL string, client *http.Client) (int, []byte, error) {
	class, current := domain.ClassifyImage(rawURL)
	if class != domain.ImageProxy {
		return 0, nil, errors.New("thumbnail host refused")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	for hop := 0; hop <= maxRedirects; hop++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, current, nil)
		if err != nil {
			return 0, nil, errors.New("thumbnail request invalid")
		}
		req.Header.Set("User-Agent", "podhub-thumbnail")
		resp, err := client.Do(req)
		if err != nil {
			return 0, nil, errors.New("thumbnail request failed")
		}
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			location := resp.Header.Get("Location")
			_ = resp.Body.Close()
			next, ok := domain.NextImageHop(current, location)
			if !ok || hop == maxRedirects {
				return resp.StatusCode, nil, errors.New("thumbnail redirect refused")
			}
			current = next
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			_ = resp.Body.Close()
			return resp.StatusCode, nil, nil
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, maxImageBytes+1))
		_ = resp.Body.Close()
		if err != nil || len(raw) > maxImageBytes || domain.SniffImage(raw) == "" {
			return resp.StatusCode, nil, errors.New("thumbnail response invalid")
		}
		return resp.StatusCode, raw, nil
	}
	return 0, nil, errors.New("thumbnail redirect limit reached")
}

var thumbnailNonPublicRanges = [...]netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("2001:db8::/32"),
}

func publicThumbnailIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.Zone() != "" {
		return false
	}
	for _, block := range thumbnailNonPublicRanges {
		if block.Contains(ip) {
			return false
		}
	}
	return true
}

func dialThumbnail(ctx context.Context, network, address string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	return dialThumbnailWith(ctx, network, address, net.DefaultResolver.LookupNetIP, dialer.DialContext)
}

func dialThumbnailWith(ctx context.Context, network, address string,
	lookup func(context.Context, string, string) ([]netip.Addr, error),
	dial func(context.Context, string, string) (net.Conn, error),
) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || port != "443" || !domain.OzonImageHost(host) {
		return nil, errors.New("thumbnail host refused")
	}
	addresses, err := lookup(ctx, "ip", host)
	if err != nil || len(addresses) == 0 {
		return nil, errors.New("thumbnail DNS unavailable")
	}
	for _, ip := range addresses {
		if !publicThumbnailIP(ip) {
			return nil, errors.New("thumbnail DNS refused")
		}
	}
	for _, ip := range addresses {
		conn, err := dial(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
	}
	return nil, errors.New("thumbnail connection failed")
}
