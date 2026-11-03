package httpx

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestPublicClientPinsTheHostAndReturnsRedirects(t *testing.T) {
	var followed bool
	next := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		followed = true
		_, _ = w.Write([]byte("landed"))
	}))
	defer next.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/stay" {
			w.Header().Set("Location", next.URL+"/landed")
			w.WriteHeader(http.StatusTemporaryRedirect)
			_, _ = w.Write([]byte("stay"))
			return
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	client := PublicClient(u.Hostname(), true)
	res, err := client.Get(srv.URL + "/stay")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusTemporaryRedirect || string(raw) != "stay" || followed {
		t.Fatalf("status %d body %q followed %v", res.StatusCode, raw, followed)
	}
	if _, err := client.Get("http://localhost" + u.Port() + "/"); err == nil {
		t.Fatal("client dialed a host outside the pin")
	}
}

func TestPublicClientRefusesLoopbackWithoutTheSwitch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	if _, err := PublicClient(u.Hostname(), false).Get(srv.URL + "/"); err == nil {
		t.Fatal("loopback dialed without the switch")
	}
}
