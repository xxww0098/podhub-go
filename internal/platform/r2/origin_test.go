package r2

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExchangeRefusesRemote(t *testing.T) {
	_, err := Exchange(context.Background(), Request{Method: http.MethodGet, URL: "https://example.com/bucket/key"})
	if err == nil || !strings.Contains(err.Error(), "non-loopback") {
		t.Fatal(err)
	}
}

func TestExchangeLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Fatalf("method %s", r.Method)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	resp, err := Exchange(context.Background(), Request{
		Method: http.MethodPut, URL: srv.URL + "/bucket/key", Body: []byte{}, NoCompress: true, StrictRead: true,
	})
	if err != nil || resp.Status != http.StatusNoContent {
		t.Fatal(resp.Status, err)
	}
}
