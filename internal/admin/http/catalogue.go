package adminhttp

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/service"
)

const (
	probeTimeout   = 20 * time.Second
	dnsTimeout     = 2 * time.Second
	probeUserAgent = "podhub-ai-probe/0.0.112"
	successCap     = 1 << 20
	errorCap       = 16 << 10
)

// catalogue is the model-list client. It does not follow redirects and does
// not use a proxy. public is the explicit public-dial switch. Off, which is
// the default, refuses a public address with the same dns refusal as a
// disallowed loopback address, and does not resolve or dial it.
type catalogue struct {
	loopback bool
	public   bool
}

// NewCatalogue builds the probe client. loopback and public are the flags
// already parsed by config.Load.
func NewCatalogue(loopback, public bool) service.Catalogue {
	return catalogue{loopback: loopback, public: public}
}

type dnsRefused struct{}

func (dnsRefused) Error() string { return "dns refused" }

func (c catalogue) Fetch(ctx context.Context, endpoint, format, apiKey string) (int, []byte, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, nil, true, dnsRefused{}
	}
	if format == "anthropic_messages" {
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")
	} else {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	if req.URL.Hostname() == "opencode.ai" && strings.HasPrefix(req.URL.Path, "/zen/go/") {
		req.Header.Set("User-Agent", probeUserAgent)
		req.Header.Set("x-opencode-session", "podhub-ai-model-probe")
	}
	res, err := c.client().Do(req)
	if err != nil {
		var refused dnsRefused
		if errors.As(err, &refused) {
			return 0, nil, true, err
		}
		return 0, nil, false, err
	}
	defer res.Body.Close()
	limit := errorCap
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		limit = successCap
	}
	buf, err := io.ReadAll(io.LimitReader(res.Body, int64(limit)+1))
	if err != nil {
		return res.StatusCode, nil, false, service.ErrProbeShort
	}
	if len(buf) > limit {
		if limit == successCap {
			return res.StatusCode, nil, false, service.ErrProbeLarge
		}
		buf = buf[:limit]
	}
	return res.StatusCode, buf, false, nil
}

var (
	probeOnce sync.Once
	probeCli  [4]*http.Client
)

func probeIndex(loopback, public bool) int {
	n := 0
	if loopback {
		n |= 1
	}
	if public {
		n |= 2
	}
	return n
}

// client is the process-wide probe client for this loopback and public
// policy. Proxy stays nil. The transport is not the plain or loopback
// bucket: those either follow the environment proxy or refuse every
// public address.
func (c catalogue) client() *http.Client {
	probeOnce.Do(func() {
		for _, allowLoop := range [2]bool{false, true} {
			for _, allowPublic := range [2]bool{false, true} {
				loop, public := allowLoop, allowPublic
				probeCli[probeIndex(loop, public)] = &http.Client{
					CheckRedirect: func(*http.Request, []*http.Request) error {
						return http.ErrUseLastResponse
					},
					Transport: &http.Transport{
						Proxy: nil,
						DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
							return dialPinned(ctx, network, addr, loop, public)
						},
					},
				}
			}
		}
	})
	return probeCli[probeIndex(c.loopback, c.public)]
}

func dialPinned(ctx context.Context, network, addr string, allowLoopback, allowPublic bool) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, dnsRefused{}
	}
	var ips []net.IP
	if ip := net.ParseIP(host); ip != nil {
		if !literalAllowed(ip, allowLoopback, allowPublic) {
			return nil, dnsRefused{}
		}
		ips = []net.IP{ip}
	} else if !allowPublic {
		return nil, dnsRefused{}
	} else {
		look, cancel := context.WithTimeout(ctx, dnsTimeout)
		defer cancel()
		found, err := net.DefaultResolver.LookupIPAddr(look, host)
		if err != nil || len(found) == 0 {
			return nil, dnsRefused{}
		}
		for _, item := range found {
			if !dnsResultAllowed(item.IP) {
				return nil, dnsRefused{}
			}
			ips = append(ips, item.IP)
		}
	}
	dialer := &net.Dialer{Timeout: probeTimeout}
	var last error
	for _, ip := range ips {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		last = err
	}
	if last == nil {
		last = dnsRefused{}
	}
	return nil, last
}

// literalAllowed is the dial gate for an address that is already an IP.
// A loopback IP needs the loopback flag. Any other IP needs the public
// flag, which is off unless config.Load saw the explicit switch.
func literalAllowed(ip net.IP, allowLoopback, allowPublic bool) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return allowLoopback
	}
	return allowPublic
}

// dnsResultAllowed accepts public addresses and the 198.18.0.0/15 fake-ip
// range. A resolved loopback or private address is refused.
func dnsResultAllowed(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if v4 := ip.To4(); v4 != nil && v4[0] == 198 && (v4[1] == 18 || v4[1] == 19) {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		if v4[0] == 100 && v4[1]&0xc0 == 64 {
			return false
		}
		if v4[0] >= 240 {
			return false
		}
		if v4[0] == 192 && v4[1] == 0 && v4[2] == 2 {
			return false
		}
		if v4[0] == 198 && v4[1] == 51 && v4[2] == 100 {
			return false
		}
		if v4[0] == 203 && v4[1] == 0 && v4[2] == 113 {
			return false
		}
	}
	return true
}
