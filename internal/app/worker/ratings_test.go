package worker

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/ratings/contract"
	"github.com/xxww0098/podhub-go/internal/seller"
)

const fixtureClient = "fixture-client-rt1"
const fixtureKey = "fixture-api-key-rt1"

func TestPostSellerInfoLoopback(t *testing.T) {
	var seen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != contract.SellerInfoPath {
			t.Errorf("request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Client-Id") != fixtureClient || r.Header.Get("Api-Key") != fixtureKey {
			t.Errorf("credential headers")
		}
		body, _ := io.ReadAll(r.Body)
		seen = string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ratings":[{"rating":"rating_delivery_complaints_fbo","name":"Жалобы по FBO","current_value":null,"past_value":null,"value_type":"RATIO","status":"UNKNOWN"}]}`))
	}))
	t.Cleanup(srv.Close)

	t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	eg := seller.New(config.Load())
	body, err := postSellerInfo(context.Background(), eg, fixtureClient, fixtureKey)
	if err != nil {
		t.Fatal(err)
	}
	if seen != `{}` {
		t.Fatalf("body %s", seen)
	}
	if eg.WritePosts() != 0 || eg.ReadPosts() != 1 {
		t.Fatalf("writes %d reads %d", eg.WritePosts(), eg.ReadPosts())
	}
	if strings.Contains(string(body), fixtureKey) || strings.Contains(string(body), fixtureClient) {
		t.Fatal("response carried the fixture secret")
	}

	t.Setenv("CLOUD_SELLER_BASE_URL", "https://api-seller.ozon.ru")
	blocked := seller.New(config.Load())
	_, err = postSellerInfo(context.Background(), blocked, fixtureClient, fixtureKey)
	if !errors.Is(err, seller.ErrRefusedOrigin) {
		t.Fatalf("refused %v", err)
	}
	if blocked.ReadPosts() != 0 || blocked.WritePosts() != 0 {
		t.Fatal("production host was dialed")
	}
	if strings.Contains(err.Error(), fixtureKey) || strings.Contains(err.Error(), fixtureClient) {
		t.Fatal("error text contains a secret")
	}
}
