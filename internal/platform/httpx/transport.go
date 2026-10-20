// Package httpx holds the process-wide HTTP transports.
//
// Callers used to allocate a Transport per request, so the connection
// pool never saw a second request. Transports are bucketed by
// DisableCompression and by whether the dialer refuses non-loopback
// addresses. The model probe does not use these buckets: its dialer
// pins DNS and its Proxy is nil, and it must not share a transport
// that follows the environment proxy.
//
// Restricted is the client for the AI upstream and the OTLP exporter.
// Its proxy is nil, so HTTP_PROXY and HTTPS_PROXY are ignored. Its dialer
// refuses a non-loopback address, and again refuses when the connected
// peer is not loopback. Redirects are not followed: CheckRedirect returns
// ErrUseLastResponse, so the caller still sees the 3xx status and body.
//
// Ozon is the Seller API client: catalog and listing reads, submit,
// accepted-import scans, delegate Seller reads, warehouse, store info,
// ratings, and the seller proxy. It uses the same dialer, proxy, and
// redirect rule as Restricted. The idle pool and the connection-level
// timeouts live on Ozon only. Overall request deadlines stay on the
// caller's Client.Timeout or context.
package httpx

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ErrNotLoopback is the dial error for a non-loopback address on a
// loopback transport. Error text matches the origin client's refusal.
var ErrNotLoopback = errors.New("refusing non-loopback media host")

var (
	plainOnce sync.Once
	plainTr   *http.Transport

	loopOnce sync.Once
	loopTr   [2]*http.Transport

	restrictedOnce sync.Once
	restrictedTr   *http.Transport

	ozonOnce sync.Once
	ozonTr   *http.Transport
)

// Plain is the shared transport for callers that previously used a
// default Client: environment proxy, compression enabled, stock dialer.
func Plain() *http.Transport {
	plainOnce.Do(func() {
		plainTr = http.DefaultTransport.(*http.Transport).Clone()
	})
	return plainTr
}

// Loopback is the shared transport that dials only loopback hosts.
// noCompress selects DisableCompression, the same bit Request.NoCompress
// used to set on a fresh Transport.
func Loopback(noCompress bool) *http.Transport {
	loopOnce.Do(func() {
		for i, compressOff := range [2]bool{false, true} {
			off := compressOff
			loopTr[i] = &http.Transport{
				DisableCompression: off,
				DialContext:        dialLoopback,
			}
		}
	})
	if noCompress {
		return loopTr[1]
	}
	return loopTr[0]
}

// UseLast tells a Client to return the redirect response unchanged.
func UseLast(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// Restricted is the shared transport that does not consult a proxy and
// dials only loopback addresses.
func Restricted() *http.Transport {
	restrictedOnce.Do(func() {
		restrictedTr = &http.Transport{
			Proxy:       nil,
			DialContext: dialRestricted,
		}
	})
	return restrictedTr
}

// RestrictedClient is a client on Restricted. A 3xx is returned to the
// caller with its status and body. The next hop is not requested. Each
// request records a client span; Base returns Restricted.
func RestrictedClient() *http.Client {
	return &http.Client{
		Transport:     traced{base: Restricted()},
		CheckRedirect: UseLast,
	}
}

// Ozon is the shared Seller transport. Seller talks to one host, so the
// per-host idle pool matches the process-wide pool. 128 covers several
// Egress values in one process, each already capped by its in-flight
// slots. MaxConnsPerHost stays unset so those slots are not also queued
// on the dial. ForceAttemptHTTP2 is set because a custom DialContext
// otherwise leaves HTTP/2 off. Cleartext http still uses HTTP/1.1.
//
// IdleConnTimeout, TLSHandshakeTimeout, ResponseHeaderTimeout, and
// ExpectContinueTimeout were unset on Restricted. They bound connection
// setup and the wait for response headers. They do not replace the
// caller's overall timeout.
func Ozon() *http.Transport {
	ozonOnce.Do(func() {
		ozonTr = &http.Transport{
			Proxy:                 nil,
			DialContext:           dialRestricted,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          128,
			MaxIdleConnsPerHost:   128,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		}
	})
	return ozonTr
}

// OzonClient is a client on Ozon. Timeout stays zero so each caller keeps
// the overall deadline it already had. A 3xx is returned to the caller.
// The next hop is not requested. Each request records a client span;
// Base returns Ozon.
func OzonClient() *http.Client {
	return &http.Client{
		Transport:     traced{base: Ozon()},
		CheckRedirect: UseLast,
	}
}

func dialLoopback(ctx context.Context, network, addr string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if !LoopbackHost(host) {
		return nil, ErrNotLoopback
	}
	return (&net.Dialer{}).DialContext(ctx, network, addr)
}

// dialRestricted checks the dial address and the address the connection
// actually reached. A name that resolves off loopback is closed.
func dialRestricted(ctx context.Context, network, addr string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if !LoopbackHost(host) {
		return nil, ErrNotLoopback
	}
	conn, err := (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	peer, _, err := net.SplitHostPort(conn.RemoteAddr().String())
	if err != nil || !LoopbackHost(peer) {
		conn.Close()
		return nil, ErrNotLoopback
	}
	return conn, nil
}

// LoopbackHost reports localhost, 127.0.0.1, ::1, and any loopback IP.
func LoopbackHost(host string) bool {
	host = strings.Trim(host, "[]")
	switch strings.ToLower(host) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
