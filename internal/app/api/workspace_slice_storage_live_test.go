package api

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestLiveVerifySliceStorage(t *testing.T) {
	if os.Getenv("PODHUB_TEST_WORKSPACE_R2_LIVE") != "1" {
		t.Skip("requires dedicated R2 test bucket")
	}
	if !strings.Contains(os.Getenv("R2_TRANSIT_BUCKET"), "-test-") {
		t.Fatal("requires test bucket")
	}
	if err := httpx.ConfigureDNS(os.Getenv("CLOUD_DNS_SERVER")); err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	prefix, _ := media.SlicePrefix(id)
	account := sign.Account{ID: id, Provider: sign.ProviderCloudflare, Endpoint: os.Getenv("R2_TRANSIT_ENDPOINT"), Bucket: os.Getenv("R2_TRANSIT_BUCKET"), PublicBaseURL: os.Getenv("R2_TRANSIT_PUBLIC_BASE_URL"), Region: "auto", ForcePathStyle: true, AccessKeyID: os.Getenv("R2_TRANSIT_ACCESS_KEY_ID"), SecretAccessKey: os.Getenv("R2_TRANSIT_SECRET_ACCESS_KEY"), KeyPrefix: prefix}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if _, err := verifySliceStorage(ctx, account, uuid.NewString(), "http://127.0.0.1:1420"); err != nil {
		t.Fatalf("R2 validation with browser CORS failed: %v", err)
	}
}
