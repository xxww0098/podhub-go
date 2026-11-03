package httpx

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ErrHostRefused is the dial refusal for a host outside the pinned policy.
var ErrHostRefused = errors.New("refusing host outside the pin")

// PublicClient returns a client pinned to one host. Each DNS answer is checked
// before dialing and the dial uses the checked address, so a second lookup
// cannot move the connection. Redirects are not followed and no proxy is used.
//
// Outside loopback, the host must resolve only to public addresses and the
// connection must use port 443. With allowLoopback, a loopback host may use any
// port; this is the local test path and still refuses non-loopback answers.
func PublicClient(host string, allowLoopback bool) *http.Client {
	host = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	key := host + "|" + strconv.FormatBool(allowLoopback)
	if cached, ok := publicClients.Load(key); ok {
		return cached.(*http.Client)
	}
	client := &http.Client{
		CheckRedirect: UseLast,
		Transport: &http.Transport{
			Proxy:                 nil,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          32,
			MaxIdleConnsPerHost:   8,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 100 * time.Second,
			ExpectContinueTimeout: time.Second,
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return dialPinnedHost(ctx, network, addr, host, allowLoopback)
			},
		},
	}
	actual, _ := publicClients.LoadOrStore(key, client)
	return actual.(*http.Client)
}

var publicClients sync.Map

func dialPinnedHost(ctx context.Context, network, addr, want string, allowLoopback bool) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, ErrHostRefused
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host != want {
		return nil, ErrHostRefused
	}
	if allowLoopback && LoopbackHost(host) {
		return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, addr)
	}
	if port != "443" {
		return nil, ErrHostRefused
	}
	var ips []netip.Addr
	if literal, err := netip.ParseAddr(host); err == nil {
		if !publicAddress(literal) {
			return nil, ErrHostRefused
		}
		ips = []netip.Addr{literal}
	} else {
		found, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil || len(found) == 0 {
			return nil, ErrHostRefused
		}
		for _, ip := range found {
			if !publicAddress(ip) {
				return nil, ErrHostRefused
			}
		}
		ips = found
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	var last error
	for _, ip := range ips {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		last = err
	}
	if last == nil {
		last = ErrHostRefused
	}
	return nil, last
}

func publicAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, raw := range []string{"100.64.0.0/10", "198.18.0.0/15", "192.0.0.0/24", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32"} {
		if netip.MustParsePrefix(raw).Contains(ip) {
			return false
		}
	}
	return true
}
