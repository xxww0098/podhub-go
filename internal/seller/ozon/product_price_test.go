package ozon

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/config"

	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
)

func TestProductPriceOfficialScopeKillSwitchAndLanes(t *testing.T) {
	oldClient := officialHTTPClient
	t.Cleanup(func() { officialHTTPClient = oldClient })
	calls := 0
	officialHTTPClient = &http.Client{Timeout: time.Second, Transport: officialRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != "https://api-seller.ozon.ru/v1/product/import/prices" || r.Method != "POST" || r.Header.Get("Client-Id") != "fixture-client" || r.Header.Get("Api-Key") != "fixture-key" {
			t.Fatal("unbound price call")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"result":[]}`)), Header: make(http.Header)}, nil
	})}
	t.Setenv("CLOUD_SELLER_BASE_URL", "")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	closed := New(config.Load())
	if _, err := closed.ProductPriceCall(context.Background(), "POST", "/v1/product/import/prices", []byte(`{}`), true, true, "fixture-client", "fixture-key"); !errors.Is(err, sellercontract.ErrWritesDisabled) || calls != 0 {
		t.Fatal("closed gate dialed")
	}
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	e := New(config.Load())
	for _, path := range []string{"/v3/product/import", "/v2/products/stocks", "/v1/product/import/prices?x=1", "https://attacker.invalid"} {
		if _, err := e.ProductPriceCall(context.Background(), "POST", path, []byte(`{}`), true, true, "fixture-client", "fixture-key"); !errors.Is(err, ErrRefusedOrigin) {
			t.Fatalf("opened path %s", path)
		}
	}
	for _, write := range []bool{false, true} {
		method := "GET"
		if !write {
			method = "POST"
		}
		if _, err := e.ProductPriceCall(context.Background(), method, "/v1/product/import/prices", []byte(`{}`), write, true, "fixture-client", "fixture-key"); !errors.Is(err, ErrRefusedOrigin) {
			t.Fatal("lane/method bypass")
		}
	}
	if _, err := e.Call(context.Background(), "POST", "/v1/product/import/prices", []byte(`{}`), true, true, "fixture-client", "fixture-key"); !errors.Is(err, ErrRefusedOrigin) {
		t.Fatal("generic public egress opened")
	}
	if reply, err := e.ProductPriceCall(context.Background(), "POST", "/v1/product/import/prices", []byte(`{}`), true, true, "fixture-client", "fixture-key"); err != nil || reply.Status != 200 || calls != 1 || e.WritePosts() != 1 || e.ReadPosts() != 0 {
		t.Fatalf("reply=%+v err=%v calls=%d", reply, err, calls)
	}
}
