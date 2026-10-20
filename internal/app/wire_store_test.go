package app

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/seller"
)

func TestSellerInfoReadIgnoresWriteSwitch(t *testing.T) {
	const key = "fixture-api-key-store-autofill"
	var posts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts++
		if r.Method != http.MethodPost || r.URL.Path != "/v1/seller/info" {
			t.Errorf("request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Client-Id") != "client-fixture" || r.Header.Get("Api-Key") != key {
			t.Errorf("headers")
		}
		raw, _ := io.ReadAll(r.Body)
		if string(raw) != `{}` {
			t.Errorf("body %s", raw)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"company":{"name":"LUAN4","legal_name":"Full","inn":"tax-inn-must-not-leak","ogrn":"tax-ogrn-must-not-leak","currency":"CNY"}}`))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	eg := seller.New(config.Load())
	status, body, err := sellerInfo{eg}.PostSellerInfo(context.Background(), "client-fixture", key)
	if err != nil || status != http.StatusOK || posts != 1 || eg.WritePosts() != 0 || eg.ReadPosts() != 1 {
		t.Fatalf("status %d err %v posts %d writes %d reads %d", status, err, posts, eg.WritePosts(), eg.ReadPosts())
	}
	if string(body) == "" {
		t.Fatal("empty body")
	}
}

func TestSellerInfoRefusesPublicHost(t *testing.T) {
	t.Setenv("CLOUD_SELLER_BASE_URL", "https://api-seller.ozon.ru")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	eg := seller.New(config.Load())
	if _, _, err := (sellerInfo{eg}).PostSellerInfo(context.Background(), "client", "fixture-api-key-store-autofill"); err != seller.ErrRefusedOrigin {
		t.Fatal(err)
	}
	if eg.ReadPosts() != 0 || eg.WritePosts() != 0 {
		t.Fatalf("reads %d writes %d", eg.ReadPosts(), eg.WritePosts())
	}
}
