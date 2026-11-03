package slicepurge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	"github.com/xxww0098/podhub-go/internal/platform/r2"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestLiveSliceStorage(t *testing.T) {
	if os.Getenv("PODHUB_TEST_WORKSPACE_R2_LIVE") != "1" {
		t.Skip("requires dedicated R2 test bucket")
	}
	if err := httpx.ConfigureDNS(os.Getenv("CLOUD_DNS_SERVER")); err != nil {
		t.Fatal(err)
	}
	bucket := os.Getenv("R2_TRANSIT_BUCKET")
	if !strings.Contains(bucket, "-test-") {
		t.Fatal("requires a test bucket")
	}
	id := uuid.NewString()
	prefix, _ := contract.SlicePrefix(id)
	account := sign.Account{ID: id, Provider: sign.ProviderCloudflare, Endpoint: os.Getenv("R2_TRANSIT_ENDPOINT"), Bucket: bucket, PublicBaseURL: os.Getenv("R2_TRANSIT_PUBLIC_BASE_URL"), Region: "auto", ForcePathStyle: true, AccessKeyID: os.Getenv("R2_TRANSIT_ACCESS_KEY_ID"), SecretAccessKey: os.Getenv("R2_TRANSIT_SECRET_ACCESS_KEY"), KeyPrefix: prefix}
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data.Bytes())
	now := time.Now()
	key, err := objectkey.ComposeBatchedKey(prefix, uuid.NewString(), hex.EncodeToString(sum[:]), "png", fmt.Sprintf("%d.%s", now.Add(-time.Minute).UnixMilli(), uuid.NewString()))
	if err != nil {
		t.Fatal(err)
	}
	origin := AccountOrigin{Account: account, Before: now}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		if _, err := origin.Delete(cleanup, []string{key}); err != nil {
			t.Errorf("exact cleanup failed")
		}
	}()
	grant, err := sign.SignPut(account, key, "image/png", uint64(data.Len()), now, hex.EncodeToString(sum[:]), nil)
	if err != nil {
		t.Fatal("sign PUT failed")
	}
	response, err := r2.ExchangeAccount(ctx, account, r2.Request{Method: http.MethodPut, URL: grant.URL, Headers: map[string]string{"Content-Type": "image/png", "If-None-Match": "*", "X-Amz-Checksum-Sha256": grant.ChecksumSHA256}, Body: data.Bytes(), StrictRead: true})
	if err != nil || response.Status != http.StatusOK {
		t.Fatalf("PUT failed, status %d: %v", response.Status, err)
	}
	privateURL, _, err := sign.PresignURL(account, http.MethodGet, key, "", now, time.Minute, nil, nil)
	if err != nil {
		t.Fatal("sign GET failed")
	}
	for _, rawURL := range []string{privateURL, sign.PublicURL(account, key)} {
		response, err = r2.ExchangeAccount(ctx, account, r2.Request{Method: http.MethodGet, URL: rawURL, StrictRead: true})
		if err != nil || response.Status != http.StatusOK || !bytes.Equal(response.Body, data.Bytes()) {
			t.Fatalf("readback failed, status %d", response.Status)
		}
	}
	keys, err := origin.List(ctx)
	if err != nil || len(keys) != 1 || keys[0] != key {
		t.Fatal("prefix list failed")
	}
	result, err := origin.Delete(ctx, keys)
	if err != nil || result.Deleted != 1 || len(result.FailedKeys) != 0 {
		t.Fatal("delete failed")
	}
	response, err = r2.ExchangeAccount(ctx, account, r2.Request{Method: http.MethodGet, URL: privateURL, StrictRead: true})
	if err != nil || response.Status != http.StatusNotFound {
		t.Fatalf("deleted object still present, status %d", response.Status)
	}
	keys, err = origin.List(ctx)
	if err != nil || len(keys) != 0 {
		t.Fatal("prefix not empty after deletion")
	}
}
