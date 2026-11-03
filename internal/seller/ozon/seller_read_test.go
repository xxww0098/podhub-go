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
)

func TestSellerReadOfficialAllowlistAndClosedWriteGate(t *testing.T) {
	previous := officialHTTPClient
	t.Cleanup(func() { officialHTTPClient = previous })
	var calls int
	officialHTTPClient = &http.Client{Transport: officialRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Scheme != "https" || r.URL.Host != "api-seller.ozon.ru" || r.URL.RawQuery != "" ||
			r.Header.Get("Client-Id") != "fixture-client" || r.Header.Get("Api-Key") != "fixture-key" {
			t.Fatal("Seller read escaped its fixed origin or credential")
		}
		raw, _ := io.ReadAll(r.Body)
		if r.Method == http.MethodGet && (r.URL.Path != "/v1/actions" || len(raw) != 0 || r.Header.Get("Content-Type") != "") {
			t.Fatal("activity list method or body changed")
		}
		if r.Method == http.MethodPost && (string(raw) != `{}` || r.Header.Get("Content-Type") != "application/json") {
			t.Fatal("Seller read body changed")
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"result":[]}`))}, nil
	})}
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	t.Setenv("CLOUD_SELLER_BASE_URL", "")
	e := New(config.Load())
	for _, path := range []string{"/v3/product/list", "/v3/product/info/list", "/v4/posting/fbs/unfulfilled/list", "/v3/posting/fbs/get", "/v1/returns/list", "/v3/chat/list", "/v3/supply-order/list", "/v2/warehouse/list", "/v2/delivery-method/list", "/v1/warehouse/operation/status", "/v1/seller/info"} {
		reply, err := e.SellerReadCall(context.Background(), http.MethodPost, path, []byte(`{}`), false, true, "fixture-client", "fixture-key")
		if err != nil || reply.Status != 200 {
			t.Fatalf("read %s: status=%d err=%v", path, reply.Status, err)
		}
	}
	if reply, err := e.SellerReadCall(context.Background(), http.MethodGet, "/v1/actions", nil, false, true, "fixture-client", "fixture-key"); err != nil || reply.Status != 200 {
		t.Fatalf("GET activities: status=%d err=%v", reply.Status, err)
	}
	before := calls
	for _, path := range []string{"/v3/product/import", "/v1/product/import/prices", "/v2/products/stocks", "/v1/chat/send/message", "/v1/chat/read", "/v1/product/archive", "/v2/products/delete", "/v1/warehouse/erfbs/update", "/v1/warehouse/erfbs/aggregator/delivery-method/update", "/v1/warehouse/erfbs/non-integrated/delivery-method/update", "/v1/roles", "/v3/product/list?x=1", "/v3/product/list/../import", "https://attacker.invalid/v3/product/list", "//attacker.invalid/v3/product/list"} {
		if _, err := e.SellerReadCall(context.Background(), http.MethodPost, path, []byte(`{}`), false, true, "fixture-client", "fixture-key"); !errors.Is(err, ErrRefusedOrigin) {
			t.Fatalf("read port accepted %q", path)
		}
	}
	for _, tc := range []struct {
		method, path, body, key string
		write                   bool
	}{
		{http.MethodPost, "/v3/product/list", `{}`, "fixture-key", true},
		{http.MethodGet, "/v3/product/list", ``, "fixture-key", false},
		{http.MethodPost, "/v1/actions", `{}`, "fixture-key", false},
		{http.MethodGet, "/v1/actions", `{}`, "fixture-key", false},
		{http.MethodPost, "/v3/product/list", ``, "fixture-key", false},
		{http.MethodPost, "/v3/product/list", `{broken`, "fixture-key", false},
		{http.MethodPost, "/v3/product/list", `{}`, "bad\r\nkey", false},
	} {
		if _, err := e.SellerReadCall(context.Background(), tc.method, tc.path, []byte(tc.body), tc.write, true, "fixture-client", tc.key); !errors.Is(err, ErrRefusedOrigin) {
			t.Fatal("read method, lane, body or credential validation bypassed")
		}
	}
	if _, err := e.Call(context.Background(), http.MethodPost, "/v3/product/list", []byte(`{}`), false, true, "fixture-client", "fixture-key"); !errors.Is(err, ErrRefusedOrigin) {
		t.Fatal("generic egress gained an official route")
	}
	if calls != before || e.ReadPosts() != before || e.WritePosts() != 0 {
		t.Fatal("refused request was sent or read consumed a write lane")
	}
}

func TestSellerReadPreservesAdmissionAndRefusesOtherOrigins(t *testing.T) {
	e := New(config.Config{})
	e.readSlots, e.iread = filled(0), filled(0)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := e.SellerReadCall(ctx, http.MethodPost, "/v3/product/list", []byte(`{}`), false, true, "fixture-client", "fixture-key"); err == nil || e.ReadPosts() != 0 {
		t.Fatal("Seller read bypassed its occupied admission lanes")
	}
	for _, e := range []*Egress{nil, {base: "https://attacker.invalid"}} {
		if _, err := e.SellerReadCall(context.Background(), http.MethodPost, "/v3/product/list", []byte(`{}`), false, true, "fixture-client", "fixture-key"); !errors.Is(err, ErrRefusedOrigin) {
			t.Fatal("read accepted an unconfigured origin")
		}
	}
}
