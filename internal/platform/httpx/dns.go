package httpx

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strings"
	"time"
)

// ConfigureDNS installs the process resolver before any clients or workers start.
// Blank keeps system DNS. A literal IP avoids resolving the DNS server itself;
// outbound clients still validate and pin the addresses returned by this resolver.
func ConfigureDNS(server string) error {
	server = strings.TrimSpace(server)
	if server == "" {
		return nil
	}
	address, err := netip.ParseAddrPort(server)
	if err != nil || address.Port() == 0 || address.Addr().Unmap().IsUnspecified() || address.Addr().Unmap().IsMulticast() {
		return errors.New("CLOUD_DNS_SERVER must be a DNS server IP and nonzero port, for example 1.1.1.1:53 or [2606:4700:4700::1111]:53")
	}
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, network, address.String())
		},
	}
	return nil
}
