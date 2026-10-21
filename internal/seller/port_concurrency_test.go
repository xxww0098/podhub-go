package seller

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/seller/domain"
)

// Listing workers share one Egress/Port. Concurrent callers must keep their
// response bytes and counters separate while retaining the two write slots.
func TestSubmitPortConcurrentWrites(t *testing.T) {
	const requests = 6
	entered := make(chan struct{}, requests)
	release := make(chan struct{})
	var active, peak atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); n > old && !peak.CompareAndSwap(old, n); old = peak.Load() {
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		entered <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	eg := New(config.Load())
	if !eg.Loopback() {
		t.Fatal("test did not configure the loopback Seller origin")
	}
	port := eg.Port()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	finished := make(chan error, requests)
	for i := range requests {
		go func() {
			body := fmt.Sprintf(`{"items":[{"offer_id":"concurrent-%d"}]}`, i)
			status, got, err := port.Write(ctx, "/v3/product/import", []byte(body))
			if err == nil && (status != http.StatusOK || got != body) {
				err = fmt.Errorf("caller %d received status=%d body=%q, want %q", i, status, got, body)
			}
			finished <- err
		}()
	}
	for range requests / domain.WriteSlots {
		// Neither handler may finish until both write slots are in use.
		for range domain.WriteSlots {
			select {
			case <-entered:
			case err := <-finished:
				t.Fatalf("request finished before the server barrier: %v", err)
			case <-ctx.Done():
				t.Fatal("shared port did not execute both write slots concurrently")
			}
		}
		for range domain.WriteSlots {
			select {
			case release <- struct{}{}:
			case <-ctx.Done():
				t.Fatal("server did not release its write slot")
			}
		}
		for range domain.WriteSlots {
			select {
			case err := <-finished:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("released request did not finish")
			}
		}
	}
	if got := peak.Load(); got != int32(domain.WriteSlots) {
		t.Fatalf("concurrent writes=%d, want slot cap=%d", got, domain.WriteSlots)
	}
	if eg.WritePosts() != requests || eg.ReadPosts() != 0 {
		t.Fatalf("write/read counters=%d/%d", eg.WritePosts(), eg.ReadPosts())
	}
}
