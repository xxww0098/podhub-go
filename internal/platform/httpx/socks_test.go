package httpx

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

func socksListener(t *testing.T, serve func(net.Conn)) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); serve(c) }()
		}
	}()
	return "socks5h://" + l.Addr().String()
}

func TestSOCKS5HForwardsHostnameWithoutResolvingIt(t *testing.T) {
	got := make(chan string, 1)
	route := socksListener(t, func(c net.Conn) {
		_ = c.SetDeadline(time.Now().Add(time.Second))
		var greeting [3]byte
		if _, err := io.ReadFull(c, greeting[:]); err != nil || greeting != [3]byte{5, 1, 0} {
			return
		}
		_, _ = c.Write([]byte{5, 0})
		var head [5]byte
		if _, err := io.ReadFull(c, head[:]); err != nil || head[0] != 5 || head[1] != 1 || head[2] != 0 || head[3] != 3 {
			return
		}
		name := make([]byte, int(head[4])+2)
		if _, err := io.ReadFull(c, name); err != nil {
			return
		}
		got <- string(name[:len(name)-2])
		_, _ = c.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
		_, _ = io.Copy(c, c)
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c, err := SOCKS5H(ctx, route, "tcp", "only-the-proxy-can-resolve.invalid:443")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if <-got != "only-the-proxy-can-resolve.invalid" {
		t.Fatal("target hostname was resolved or changed locally")
	}
	if _, err := c.Write([]byte("roundtrip")); err != nil {
		t.Fatal(err)
	}
	var reply [9]byte
	if _, err := io.ReadFull(c, reply[:]); err != nil || string(reply[:]) != "roundtrip" {
		t.Fatalf("tunnel failed: %v", err)
	}
}

func TestSOCKS5HRejectsHandshakeAndHonorsCancellation(t *testing.T) {
	for _, reply := range [][]byte{{5, 2}, {4, 0}} {
		route := socksListener(t, func(c net.Conn) {
			var greeting [3]byte
			_, _ = io.ReadFull(c, greeting[:])
			_, _ = c.Write(reply)
		})
		if c, err := SOCKS5H(context.Background(), route, "tcp", "api-seller.ozon.ru:443"); !errors.Is(err, ErrSOCKS) || c != nil {
			t.Fatal("unsupported method or protocol was accepted")
		}
	}
	closed := make(chan struct{}, 1)
	route := socksListener(t, func(c net.Conn) {
		_, _ = io.Copy(io.Discard, c)
		closed <- struct{}{}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if c, err := SOCKS5H(ctx, route, "tcp", "api-seller.ozon.ru:443"); err == nil || c != nil {
		t.Fatal("hung SOCKS negotiation ignored cancellation")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("canceled SOCKS connection leaked")
	}
	for _, bad := range []string{"http://127.0.0.1:9", "socks5h://u:p@127.0.0.1:9", "socks5h://127.0.0.1:9/path"} {
		if c, err := SOCKS5H(context.Background(), bad, "tcp", "api-seller.ozon.ru:443"); err == nil || c != nil {
			t.Fatal("invalid route accepted")
		}
	}
}
