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

func TestProductMutationOfficialScopeKillSwitchAndLanes(t *testing.T) {
	oldClient := officialHTTPClient
	t.Cleanup(func() { officialHTTPClient = oldClient })
	calls := 0
	var paths []string
	officialHTTPClient = &http.Client{Timeout: time.Second, Transport: officialRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		paths = append(paths, r.URL.Path)
		if r.URL.Scheme != "https" || r.URL.Host != "api-seller.ozon.ru" || r.Method != "POST" || r.Header.Get("Client-Id") != "fixture-client" || r.Header.Get("Api-Key") != "fixture-key" {
			t.Fatal("unbound product mutation call")
		}
		body, err := io.ReadAll(r.Body)
		if err != nil || string(body) != `{"stocks":[]}` {
			t.Fatalf("body=%s err=%v", body, err)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"result":[]}`)), Header: make(http.Header)}, nil
	})}
	t.Setenv("CLOUD_SELLER_BASE_URL", "")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	closed := New(config.Load())
	if _, err := closed.ProductMutationCall(context.Background(), "POST", "/v2/products/stocks", []byte(`{"stocks":[]}`), true, true, "fixture-client", "fixture-key"); !errors.Is(err, sellercontract.ErrWritesDisabled) || calls != 0 {
		t.Fatal("closed gate dialed")
	}
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	e := New(config.Load())
	for _, path := range []string{"/v3/product/import", "/v1/product/import/prices", "/v2/products/stocks/", "/v2/products/stocks?x=1", "https://attacker.invalid"} {
		if _, err := e.ProductMutationCall(context.Background(), "POST", path, []byte(`{"stocks":[]}`), true, true, "fixture-client", "fixture-key"); !errors.Is(err, ErrRefusedOrigin) {
			t.Fatalf("opened path %s", path)
		}
	}
	for _, write := range []bool{false, true} {
		method := "GET"
		if !write {
			method = "POST"
		}
		if _, err := e.ProductMutationCall(context.Background(), method, "/v2/products/stocks", []byte(`{"stocks":[]}`), write, true, "fixture-client", "fixture-key"); !errors.Is(err, ErrRefusedOrigin) {
			t.Fatal("lane/method bypass")
		}
	}
	for _, tc := range []struct{ clientID, apiKey, body string }{
		{"", "fixture-key", `{"stocks":[]}`},
		{"fixture-client", "bad\r\nkey", `{"stocks":[]}`},
		{"fixture-client", "fixture-key", `{`},
		{"fixture-client", "fixture-key", ""},
	} {
		if _, err := e.ProductMutationCall(context.Background(), "POST", "/v2/products/stocks", []byte(tc.body), true, true, tc.clientID, tc.apiKey); !errors.Is(err, ErrRefusedOrigin) {
			t.Fatalf("invalid admission opened: %+v", tc)
		}
	}
	if _, err := e.Call(context.Background(), "POST", "/v2/products/stocks", []byte(`{"stocks":[]}`), true, true, "fixture-client", "fixture-key"); !errors.Is(err, ErrRefusedOrigin) {
		t.Fatal("generic public egress opened")
	}
	for _, path := range []string{"/v2/products/stocks", "/v1/product/archive", "/v1/product/unarchive", "/v2/products/delete"} {
		if reply, err := e.ProductMutationCall(context.Background(), "POST", path, []byte(`{"stocks":[]}`), true, true, "fixture-client", "fixture-key"); err != nil || reply.Status != 200 {
			t.Fatalf("path=%s reply=%+v err=%v", path, reply, err)
		}
	}
	if calls != 4 || e.WritePosts() != 4 || e.ReadPosts() != 0 || len(paths) != 4 {
		t.Fatalf("calls=%d writes=%d reads=%d paths=%v", calls, e.WritePosts(), e.ReadPosts(), paths)
	}
	e.base = "https://attacker.invalid"
	if _, err := e.ProductMutationCall(context.Background(), "POST", "/v2/products/stocks", []byte(`{"stocks":[]}`), true, true, "fixture-client", "fixture-key"); !errors.Is(err, ErrRefusedOrigin) || calls != 4 {
		t.Fatal("external origin opened")
	}
}
