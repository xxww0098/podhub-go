package adminhttp

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/httpx"
)

func TestProbeTransportStaysOffProxyAndPlain(t *testing.T) {
	allowCat := catalogue{loopback: true}
	denyCat := catalogue{loopback: false}
	allow := allowCat.client()
	deny := denyCat.client()
	if allow == deny {
		t.Fatal("loopback policies share a client")
	}
	if allow != allowCat.client() || deny != denyCat.client() {
		t.Fatal("probe client is not process-wide")
	}
	at := allow.Transport.(*http.Transport)
	dt := deny.Transport.(*http.Transport)
	if at == dt {
		t.Fatal("probe transports aliased")
	}
	if at.Proxy != nil || dt.Proxy != nil {
		t.Fatal("probe proxy is set")
	}
	if at.DisableCompression || dt.DisableCompression {
		t.Fatal("probe DisableCompression changed")
	}
	for _, tr := range []*http.Transport{at, dt} {
		if tr == httpx.Plain() || tr == httpx.Loopback(false) || tr == httpx.Loopback(true) {
			t.Fatal("probe reused a plain or loopback transport")
		}
	}
}

func TestProbeFetchLoopbackBytes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/next" {
			w.Write([]byte("followed"))
			return
		}
		if r.Header.Get("Authorization") != "Bearer k" {
			t.Errorf("auth %q", r.Header.Get("Authorization"))
		}
		if r.URL.Path == "/redir" {
			http.Redirect(w, r, "/next", http.StatusFound)
			return
		}
		w.Write([]byte("models"))
	}))
	defer srv.Close()

	code, body, dns, err := catalogue{loopback: true}.Fetch(context.Background(), srv.URL+"/models", "openai", "k")
	if err != nil || dns || code != 200 || string(body) != "models" {
		t.Fatalf("status %d body %q dns %v err %v", code, body, dns, err)
	}
	code, body, dns, err = catalogue{loopback: true}.Fetch(context.Background(), srv.URL+"/redir", "openai", "k")
	if err != nil || dns || code != http.StatusFound || string(body) == "followed" {
		t.Fatalf("redirect status %d body %q dns %v err %v", code, body, dns, err)
	}
	_, _, dns, err = catalogue{loopback: false}.Fetch(context.Background(), srv.URL+"/models", "openai", "k")
	if !dns {
		t.Fatalf("loopback dial allowed, err %v", err)
	}
}

func TestProbePublicDefaultMatchesLoopbackRefusal(t *testing.T) {
	dialed := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dialed = true
		_, _ = w.Write([]byte("models"))
	}))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_, _, dnsLoop, errLoop := catalogue{loopback: false}.Fetch(ctx, srv.URL+"/models", "openai", "k")
	_, _, dnsIP, errIP := catalogue{}.Fetch(ctx, "https://1.2.3.4/models", "openai", "k")
	_, _, dnsName, errName := catalogue{}.Fetch(ctx, "https://example.com/models", "openai", "k")
	_, _, dnsPrivate, errPrivate := NewCatalogue(false, false).Fetch(ctx, "https://10.1.1.1/models", "openai", "k")
	if dialed {
		t.Fatal("a refused probe dialed the loopback server")
	}
	for _, item := range []struct {
		name string
		dns  bool
		err  error
	}{
		{"loopback", dnsLoop, errLoop},
		{"public-ip", dnsIP, errIP},
		{"name", dnsName, errName},
		{"private", dnsPrivate, errPrivate},
	} {
		var refused dnsRefused
		if !item.dns || !errors.As(item.err, &refused) || refused.Error() != "dns refused" {
			t.Fatalf("%s dns %v err %v", item.name, item.dns, item.err)
		}
	}
	if literalAllowed(net.ParseIP("1.2.3.4"), false, false) || !literalAllowed(net.ParseIP("1.2.3.4"), false, true) {
		t.Fatal("public switch")
	}
	if literalAllowed(net.ParseIP("10.1.1.1"), false, false) || !literalAllowed(net.ParseIP("127.0.0.1"), true, false) {
		t.Fatal("literal gate")
	}
	pub := catalogue{loopback: true, public: true}.client()
	loc := catalogue{loopback: true, public: false}.client()
	if pub == loc || pub.Transport == loc.Transport {
		t.Fatal("public policy shares a client")
	}
	code, body, dns, err := NewCatalogue(true, false).Fetch(context.Background(), srv.URL+"/models", "openai", "k")
	if err != nil || dns || code != 200 || string(body) != "models" || !dialed {
		t.Fatalf("loopback with public off: %d %q dns %v dialed %v err %v", code, body, dns, dialed, err)
	}
}
