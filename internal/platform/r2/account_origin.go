package r2

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

// ExchangeAccount permits only the configured R2 API or read-only public origin.
// DNS results are checked and dialed directly; redirects and proxies are disabled.
func ExchangeAccount(ctx context.Context, account sigv4.Account, req Request) (Response, error) {
	origin, err := accountOrigin(account, req)
	if err != nil {
		return Response{}, err
	}
	if originLoopback(origin.Hostname()) {
		return Exchange(ctx, req)
	}
	transport := &http.Transport{
		DisableCompression:    req.NoCompress,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil || !strings.EqualFold(host, origin.Hostname()) || port != "443" {
				return nil, errors.New("refusing unconfigured R2 origin")
			}
			addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
			if err != nil {
				return nil, errors.New("R2 origin DNS lookup failed")
			}
			if len(addresses) == 0 {
				return nil, errors.New("R2 origin has no addresses")
			}
			for _, address := range addresses {
				if !publicOriginIP(address) {
					return nil, errors.New("refusing non-public R2 origin address")
				}
			}
			dialer := net.Dialer{Timeout: 10 * time.Second}
			for _, address := range addresses {
				conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(address.String(), port))
				if err == nil {
					return conn, nil
				}
			}
			return nil, errors.New("R2 origin connection failed")
		},
	}
	defer transport.CloseIdleConnections()
	return exchange(ctx, req, transport)
}

func accountOrigin(account sigv4.Account, req Request) (*url.URL, error) {
	refuse := &Fault{Remote: true, Detail: "refusing unconfigured R2 origin"}
	target, err := url.Parse(req.URL)
	if err != nil || target.User != nil || target.Fragment != "" || target.Opaque != "" {
		return nil, refuse
	}
	endpoint, err := url.Parse(strings.TrimSpace(account.Endpoint))
	if err != nil || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || endpoint.Opaque != "" || (endpoint.Path != "" && endpoint.Path != "/") {
		return nil, refuse
	}
	sameOrigin := func(base *url.URL) bool {
		return target.Scheme == base.Scheme && strings.EqualFold(target.Host, base.Host)
	}
	if originLoopback(endpoint.Hostname()) {
		if (endpoint.Scheme == "http" || endpoint.Scheme == "https") && sameOrigin(endpoint) {
			return endpoint, nil
		}
		return nil, refuse
	}
	if account.Provider != sigv4.ProviderCloudflare || endpoint.Scheme != "https" || endpoint.Port() != "" || !r2APIHost(endpoint.Hostname()) {
		return nil, refuse
	}
	if sameOrigin(endpoint) {
		return endpoint, nil
	}
	public, err := url.Parse(strings.TrimSpace(account.PublicBaseURL))
	if err != nil || public.Scheme != "https" || public.Hostname() == "" || public.Port() != "" || public.User != nil || public.RawQuery != "" || public.Fragment != "" || public.Opaque != "" || net.ParseIP(public.Hostname()) != nil || originLoopback(public.Hostname()) {
		return nil, refuse
	}
	if (req.Method == http.MethodGet || req.Method == http.MethodHead) && sameOrigin(public) {
		return public, nil
	}
	return nil, refuse
}

func r2APIHost(host string) bool {
	const suffix = ".r2.cloudflarestorage.com"
	host = strings.ToLower(host)
	if !strings.HasSuffix(host, suffix) {
		return false
	}
	labels := strings.Split(strings.TrimSuffix(host, suffix), ".")
	if len(labels) > 2 || len(labels) == 2 && labels[1] != "eu" && labels[1] != "fedramp" || len(labels[0]) != 32 {
		return false
	}
	for _, char := range labels[0] {
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f') {
			return false
		}
	}
	return true
}

var nonPublicOriginRanges = [...]netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:db8::/32"),
}

func publicOriginIP(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() {
		return false
	}
	for _, block := range nonPublicOriginRanges {
		if block.Contains(address) {
			return false
		}
	}
	return true
}
