package httpx

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/url"
	"strconv"
	"time"
)

var ErrSOCKS = errors.New("SOCKS5 route unavailable")

// SOCKS5H connects through a configured, unauthenticated sidecar. The target
// hostname is sent to the proxy unchanged; no local target DNS is performed.
func SOCKS5H(ctx context.Context, route, network, target string) (net.Conn, error) {
	u, err := url.Parse(route)
	if err != nil || u.Scheme != "socks5h" || u.User != nil || u.Hostname() == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || (network != "tcp" && network != "tcp4" && network != "tcp6") {
		return nil, ErrSOCKS
	}
	if _, _, err := net.SplitHostPort(u.Host); err != nil {
		return nil, ErrSOCKS
	}
	proxyPort, err := strconv.ParseUint(u.Port(), 10, 16)
	if err != nil || proxyPort == 0 {
		return nil, ErrSOCKS
	}
	host, portText, err := net.SplitHostPort(target)
	if err != nil || len(host) == 0 || len(host) > 255 {
		return nil, ErrSOCKS
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || port == 0 {
		return nil, ErrSOCKS
	}
	conn, err := (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, u.Host)
	if err != nil {
		return nil, ErrSOCKS
	}
	ok := false
	defer func() {
		if !ok {
			_ = conn.Close()
		}
	}()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	deadline := time.Now().Add(5 * time.Second)
	if at, has := ctx.Deadline(); has && at.Before(deadline) {
		deadline = at
	}
	_ = conn.SetDeadline(deadline)
	if _, err := conn.Write([]byte{5, 1, 0}); err != nil {
		return nil, ErrSOCKS
	}
	var greeting [2]byte
	if _, err := io.ReadFull(conn, greeting[:]); err != nil || greeting != [2]byte{5, 0} {
		return nil, ErrSOCKS
	}
	request := append([]byte{5, 1, 0, 3, byte(len(host))}, []byte(host)...)
	request = binary.BigEndian.AppendUint16(request, uint16(port))
	if _, err := conn.Write(request); err != nil {
		return nil, ErrSOCKS
	}
	var response [4]byte
	if _, err := io.ReadFull(conn, response[:]); err != nil || response[0] != 5 || response[1] != 0 || response[2] != 0 {
		return nil, ErrSOCKS
	}
	length := 0
	switch response[3] {
	case 1:
		length = 4
	case 4:
		length = 16
	case 3:
		var size [1]byte
		if _, err := io.ReadFull(conn, size[:]); err != nil || size[0] == 0 {
			return nil, ErrSOCKS
		}
		length = int(size[0])
	default:
		return nil, ErrSOCKS
	}
	if _, err := io.CopyN(io.Discard, conn, int64(length+2)); err != nil || ctx.Err() != nil {
		return nil, ErrSOCKS
	}
	_ = conn.SetDeadline(time.Time{})
	ok = true
	return conn, nil
}
