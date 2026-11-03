package observerepo

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestLoopbackFetchDoesNotFollowRedirects(t *testing.T) {
	var followed atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		followed.Store(true)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer source.Close()

	status, _, err := LoopbackFetch(context.Background(), source.URL)
	if err != nil || status != http.StatusFound || followed.Load() {
		t.Fatalf("status=%d followed=%v err=%v", status, followed.Load(), err)
	}
	if _, _, err := LoopbackFetch(context.Background(), "https://example.invalid/image"); err == nil {
		t.Fatal("non-loopback host was accepted")
	}
}
