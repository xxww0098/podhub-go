package adminhttp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/admin/service"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestR2OriginUsesExplicitResponseLimit(t *testing.T) {
	const payload = "8BPSbounded-object"
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept-Encoding") != "" {
			t.Error("object digest read enabled transparent compression")
		}
		_, _ = w.Write([]byte(payload))
	}))
	defer origin.Close()
	account := sign.Account{Provider: sign.ProviderCloudflare, Endpoint: origin.URL, Bucket: "assets", ForcePathStyle: true}
	for _, limit := range []int64{int64(len(payload)), int64(len(payload) - 1)} {
		response, err := (R2Origin{}).Do(context.Background(), service.ObjectRequest{Account: account, Method: "GET", URL: origin.URL + "/assets/file.psd", MaxBytes: limit})
		if limit == int64(len(payload)) {
			if err != nil || string(response.Body) != payload {
				t.Fatalf("bounded body read err=%v", err)
			}
		} else if err == nil || !strings.Contains(err.Error(), "exceeds limit") {
			t.Fatal("response exceeding the authorized size was accepted")
		}
	}
}
