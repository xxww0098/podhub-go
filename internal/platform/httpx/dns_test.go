package httpx

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func configuredTestDNS(t *testing.T, server string) *net.Resolver {
	t.Helper()
	previous := net.DefaultResolver
	t.Cleanup(func() { net.DefaultResolver = previous })
	if err := ConfigureDNS(server); err != nil {
		t.Fatal(err)
	}
	return net.DefaultResolver
}

func TestConfigureDNSDefaultAndValidation(t *testing.T) {
	previous := net.DefaultResolver
	for _, value := range []string{"", " \t"} {
		if err := ConfigureDNS(value); err != nil || net.DefaultResolver != previous {
			t.Fatalf("blank DNS replaced system resolver: %v", err)
		}
	}
	for _, value := range []string{"1.1.1.1", "dns.example:53", "https://1.1.1.1:53", "1.1.1.1:0", "1.1.1.1:65536", "1.1.1.1:dns", "0.0.0.0:53", "[::]:53", "[ff02::1]:53", "[::ffff:0.0.0.0]:53", "2606:4700:4700::1111:53"} {
		if err := ConfigureDNS(value); err == nil || !strings.Contains(err.Error(), "CLOUD_DNS_SERVER") || net.DefaultResolver != previous {
			t.Fatalf("invalid server %q changed resolver or lacked diagnostic: %v", value, err)
		}
	}
}

func TestDNSUDPAndTCPFallback(t *testing.T) {
	for _, truncated := range []bool{false, true} {
		t.Run(map[bool]string{false: "udp", true: "truncated_udp_falls_back_to_tcp"}[truncated], func(t *testing.T) {
			server, udpCalls, tcpCalls := dnsTestServer(t, "4", truncated)
			resolver := configuredTestDNS(t, server)
			if !resolver.PreferGo || resolver.Dial == nil {
				t.Fatal("explicit DNS must bypass the platform resolver")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			addresses, err := resolver.LookupNetIP(ctx, "ip4", "qa-dns.invalid.")
			if err != nil || len(addresses) != 1 || addresses[0] != netip.MustParseAddr("203.0.113.42") {
				t.Fatalf("configured DNS lookup: %v, %v", addresses, err)
			}
			if udpCalls.Load() == 0 || (truncated && tcpCalls.Load() == 0) || (!truncated && tcpCalls.Load() != 0) {
				t.Fatalf("unexpected DNS transports: udp=%d tcp=%d", udpCalls.Load(), tcpCalls.Load())
			}
		})
	}
}

func TestDNSIPv6AndNetworkPreservation(t *testing.T) {
	server, _, _ := dnsTestServer(t, "6", false)
	resolver := configuredTestDNS(t, server)
	for _, network := range []string{"udp6", "tcp6"} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		conn, err := resolver.Dial(ctx, network, "ignored-system-server:53")
		cancel()
		if err != nil {
			t.Fatalf("%s to explicit IPv6 DNS server: %v", network, err)
		}
		if conn.RemoteAddr().String() != server {
			t.Fatalf("%s dialed %s instead of %s", network, conn.RemoteAddr(), server)
		}
		conn.Close()
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	addresses, err := resolver.LookupNetIP(ctx, "ip4", "ipv6-dns.invalid.")
	if err != nil || len(addresses) != 1 || addresses[0] != netip.MustParseAddr("203.0.113.42") {
		t.Fatalf("lookup through the explicit IPv6 DNS server: %v, %v", addresses, err)
	}
}

func TestDNSCancellationAndDeadline(t *testing.T) {
	blackhole, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { blackhole.Close() })
	resolver := configuredTestDNS(t, blackhole.LocalAddr().String())
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if conn, err := resolver.Dial(canceled, "tcp", "ignored:53"); !errors.Is(err, context.Canceled) {
		if conn != nil {
			conn.Close()
		}
		t.Fatalf("DNS dial ignored cancellation: %v", err)
	}
	ctx, stop := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer stop()
	start := time.Now()
	_, err = resolver.LookupNetIP(ctx, "ip4", "timeout-dns.invalid.")
	var dnsErr *net.DNSError
	if !errors.As(err, &dnsErr) || !dnsErr.Timeout() || time.Since(start) > time.Second {
		t.Fatalf("DNS lookup ignored deadline: %v after %s", err, time.Since(start))
	}
	if _, err := Loopback(false).DialContext(context.Background(), "tcp", "198.18.0.1:443"); !errors.Is(err, ErrNotLoopback) {
		t.Fatalf("explicit DNS relaxed the existing address restriction: %v", err)
	}
}

func dnsTestServer(t *testing.T, family string, truncated bool) (string, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	host := "127.0.0.1:0"
	if family == "6" {
		host = "[::1]:0"
	}
	tcp, err := net.Listen("tcp"+family, host)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tcp.Close() })
	udp, err := net.ListenPacket("udp"+family, tcp.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { udp.Close() })
	udpCalls, tcpCalls := new(atomic.Int32), new(atomic.Int32)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, peer, err := udp.ReadFrom(buf)
			if err != nil {
				return
			}
			udpCalls.Add(1)
			_, _ = udp.WriteTo(dnsTestResponse(buf[:n], truncated), peer)
		}
	}()
	go func() {
		for {
			conn, err := tcp.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(time.Second))
				var size [2]byte
				if _, err := io.ReadFull(conn, size[:]); err != nil {
					return
				}
				query := make([]byte, binary.BigEndian.Uint16(size[:]))
				if _, err := io.ReadFull(conn, query); err != nil {
					return
				}
				tcpCalls.Add(1)
				response := dnsTestResponse(query, false)
				binary.BigEndian.PutUint16(size[:], uint16(len(response)))
				_, _ = conn.Write(append(size[:], response...))
			}()
		}
	}()
	return tcp.Addr().String(), udpCalls, tcpCalls
}

func dnsTestResponse(query []byte, truncated bool) []byte {
	end := 12
	for query[end] != 0 {
		end += 1 + int(query[end])
	}
	end += 5
	response := append([]byte(nil), query[:end]...)
	response[2], response[3] = 0x81, 0x80
	for i := 6; i < 12; i++ {
		response[i] = 0
	}
	if truncated {
		response[2] |= 0x02
		return response
	}
	response[7] = 1
	return append(response, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 203, 0, 113, 42)
}
