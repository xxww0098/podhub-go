package ozon

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
)

func TestPromotionOfficialScopeKillSwitchAndLanes(t *testing.T) {
	oldClient := officialHTTPClient
	t.Cleanup(func() { officialHTTPClient = oldClient })
	calls := 0
	client := *oldClient
	client.Transport = officialRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Scheme != "https" || r.URL.Host != "api-seller.ozon.ru" || r.Method != "POST" || r.URL.Path != "/v1/actions/products/update" && r.URL.Path != "/v2/actions/products/deactivate" || r.Header.Get("Client-Id") != "fixture-client" || r.Header.Get("Api-Key") != "fixture-key" {
			t.Fatal("unbound promotion call")
		}
		body, err := io.ReadAll(r.Body)
		if err != nil || string(body) != `{"action_id":7}` {
			t.Fatalf("body=%s err=%v", body, err)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"product_ids":[]}`)), Header: make(http.Header)}, nil
	})
	officialHTTPClient = &client
	t.Setenv("CLOUD_SELLER_BASE_URL", "")
	t.Setenv("CLOUD_SELLER_EGRESS_ROUTES", "direct")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	closed := New(config.Load())
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	if _, err := closed.PromotionCall(context.Background(), "POST", "/v1/actions/products/update", []byte(`{"action_id":7}`), true, true, "fixture-client", "fixture-key"); !errors.Is(err, sellercontract.ErrWritesDisabled) || calls != 0 {
		t.Fatal("captured closed gate dialed")
	}
	var missing *Egress
	if _, err := missing.PromotionCall(context.Background(), "POST", "/v1/actions/products/update", []byte(`{}`), true, true, "fixture-client", "fixture-key"); !errors.Is(err, sellercontract.ErrWritesDisabled) {
		t.Fatal("nil egress opened")
	}
	e := New(config.Load())
	for _, path := range []string{"/v1/product/import/prices", "/v1/actions/products/activate", "/v1/actions/products/deactivate", "/v1/actions", "/v1/actions/products/update?x=1", "/v1/actions/products/update#x", "https://attacker.invalid/v1/actions/products/update", "//attacker.invalid/v1/actions/products/update"} {
		if _, err := e.PromotionCall(context.Background(), "POST", path, []byte(`{}`), true, true, "fixture-client", "fixture-key"); !errors.Is(err, ErrRefusedOrigin) {
			t.Fatalf("opened path %s", path)
		}
	}
	for _, tc := range []struct {
		method, clientID, apiKey, body string
		write                          bool
	}{
		{"GET", "fixture-client", "fixture-key", `{}`, true},
		{"POST", "fixture-client", "fixture-key", `{}`, false},
		{"POST", "", "fixture-key", `{}`, true},
		{"POST", "fixture-client", "bad\r\nkey", `{}`, true},
		{"POST", "fixture-client", "fixture-key", `{`, true},
		{"POST", "fixture-client", "fixture-key", "", true},
	} {
		if _, err := e.PromotionCall(context.Background(), tc.method, "/v1/actions/products/update", []byte(tc.body), tc.write, true, tc.clientID, tc.apiKey); !errors.Is(err, ErrRefusedOrigin) {
			t.Fatalf("invalid admission opened: %+v", tc)
		}
	}
	if _, err := e.PromotionCall(context.Background(), "POST", "/v1/actions/products/update", []byte(`{"padding":"`+strings.Repeat("x", 8<<20)+`"}`), true, true, "fixture-client", "fixture-key"); !errors.Is(err, ErrRefusedOrigin) {
		t.Fatal("oversized body opened")
	}
	for _, path := range []string{"/v1/actions/products/update", "/v2/actions/products/deactivate"} {
		if _, err := e.Call(context.Background(), "POST", path, []byte(`{}`), true, true, "fixture-client", "fixture-key"); !errors.Is(err, ErrRefusedOrigin) {
			t.Fatal("generic official egress opened")
		}
	}
	if calls != 0 {
		t.Fatal("refused request dialed")
	}
	for _, path := range []string{"/v1/actions/products/update", "/v2/actions/products/deactivate"} {
		if reply, err := e.PromotionCall(context.Background(), "POST", path, []byte(`{"action_id":7}`), true, true, "fixture-client", "fixture-key"); err != nil || reply.Status != 200 {
			t.Fatalf("reply=%+v err=%v", reply, err)
		}
	}
	if calls != 2 || e.WritePosts() != 2 || e.ReadPosts() != 0 {
		t.Fatalf("calls=%d writes=%d reads=%d", calls, e.WritePosts(), e.ReadPosts())
	}
	e.base = "https://attacker.invalid"
	if _, err := e.PromotionCall(context.Background(), "POST", "/v1/actions/products/update", []byte(`{}`), true, true, "fixture-client", "fixture-key"); !errors.Is(err, ErrRefusedOrigin) || calls != 2 {
		t.Fatal("external origin opened")
	}
}

func TestPromotionDoesNotRedirectRetryOrBypassWriteSlots(t *testing.T) {
	oldClient := officialHTTPClient
	t.Cleanup(func() { officialHTTPClient = oldClient })
	t.Setenv("CLOUD_SELLER_BASE_URL", "")
	t.Setenv("CLOUD_SELLER_EGRESS_ROUTES", "direct")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	calls, status := 0, 302
	transportErr := false
	client := *oldClient
	client.Transport = officialRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "api-seller.ozon.ru" {
			t.Fatal("redirect followed with shop credentials")
		}
		if transportErr {
			return nil, errors.New("connection interrupted")
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(`{"message":"not accepted"}`)), Header: http.Header{"Location": []string{"https://attacker.invalid/collect"}}}, nil
	})
	officialHTTPClient = &client
	e := New(config.Load())
	for _, value := range []int{302, 429, 503} {
		status = value
		before := calls
		reply, err := e.PromotionCall(context.Background(), "POST", "/v1/actions/products/update", []byte(`{}`), true, true, "fixture-client", "fixture-key")
		if err != nil || reply.Status != status || calls != before+1 {
			t.Fatalf("status=%d reply=%+v err=%v calls=%d", status, reply, err, calls)
		}
	}
	transportErr = true
	before := calls
	if _, err := e.PromotionCall(context.Background(), "POST", "/v1/actions/products/update", []byte(`{}`), true, true, "fixture-client", "fixture-key"); err == nil || calls != before+1 {
		t.Fatal("transport failure retried or ignored")
	}
	for len(e.iwrite) > 0 {
		<-e.iwrite
	}
	for len(e.writeSlots) > 0 {
		<-e.writeSlots
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	before = calls
	if _, err := e.PromotionCall(ctx, "POST", "/v1/actions/products/update", []byte(`{}`), true, true, "fixture-client", "fixture-key"); err == nil || calls != before {
		t.Fatal("saturated write lane dialed")
	}
}

func TestPromotionSupportsAdmittedLoopbackFixtures(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "POST" || r.URL.Path != "/v2/actions/products/deactivate" || r.Header.Get("Client-Id") != "fixture-client" || r.Header.Get("Api-Key") != "fixture-key" {
			t.Error("loopback binding lost")
		}
		_, _ = io.WriteString(w, `{"product_ids":["41"]}`)
	}))
	defer srv.Close()
	t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")
	t.Setenv("CLOUD_SELLER_EGRESS_ROUTES", "direct")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	e := New(config.Load())
	reply, err := e.PromotionCall(context.Background(), "POST", "/v2/actions/products/deactivate", []byte(`{"action_id":7,"product_ids":["41"]}`), true, true, "fixture-client", "fixture-key")
	if err != nil || reply.Status != 200 || calls != 1 || e.WritePosts() != 1 {
		t.Fatalf("reply=%+v err=%v calls=%d", reply, err, calls)
	}
}
