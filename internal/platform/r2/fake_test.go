package r2

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/johannesboyne/gofakes3"
	"github.com/johannesboyne/gofakes3/backend/s3mem"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

func TestPartialOrNonLoopbackR2RefusesDelete(t *testing.T) {
	cases := []struct {
		name     string
		endpoint string
		bucket   string
		key      string
		secret   string
	}{
		{name: "bucket only", bucket: "podhub-slices"},
		{name: "localhost", endpoint: "http://localhost:9000", bucket: "podhub-slices", key: "k", secret: "s"},
		{name: "ipv6", endpoint: "http://[::1]:9000", bucket: "podhub-slices", key: "k", secret: "s"},
		{name: "userinfo", endpoint: "http://user:pass@127.0.0.1:9000", bucket: "podhub-slices", key: "k", secret: "s"},
		{name: "cloudflare", endpoint: "https://example.r2.cloudflarestorage.com", bucket: "podhub-slices", key: "k", secret: "s"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CLOUD_MEDIA_GC_DELETE", "1")
			t.Setenv("R2_ENDPOINT", tc.endpoint)
			t.Setenv("R2_BUCKET", tc.bucket)
			t.Setenv("R2_ACCESS_KEY_ID", tc.key)
			t.Setenv("R2_SECRET_ACCESS_KEY", tc.secret)
			if _, err := New(config.Load()); err != ErrRewriteBucketRefuse {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestRemoteHostIsNotDialedWhenDeleteIsOff(t *testing.T) {
	t.Setenv("CLOUD_MEDIA_GC_DELETE", "0")
	t.Setenv("R2_ENDPOINT", "https://example.r2.cloudflarestorage.com")
	t.Setenv("R2_BUCKET", "podhub-slices")
	t.Setenv("R2_ACCESS_KEY_ID", "test")
	t.Setenv("R2_SECRET_ACCESS_KEY", "test")
	client, err := New(config.Load())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.ListKeys(context.Background(), "podhub-slices"); err != ErrRemoteRefused {
		t.Fatalf("got %v", err)
	}
	if err := client.PutBytes(context.Background(), "podhub-slices", "k", "text/plain", []byte("x")); err != ErrRemoteRefused {
		t.Fatalf("put %v", err)
	}
}

func TestFakeBucketDeleteAndDisabledDelete(t *testing.T) {
	srv := newFake(t)
	ctx := context.Background()
	t.Setenv("CLOUD_MEDIA_GC_DELETE", "1")
	t.Setenv("R2_ENDPOINT", srv.URL)
	t.Setenv("R2_BUCKET", "podhub-slices")
	t.Setenv("R2_ACCESS_KEY_ID", "test")
	t.Setenv("R2_SECRET_ACCESS_KEY", "test")
	client, err := New(config.Load())
	if err != nil || !client.LoopbackDelete() {
		t.Fatalf("client %v %v", client, err)
	}
	if err := client.CreateBucket(ctx, "podhub-slices"); err != nil {
		t.Fatal(err)
	}
	if err := client.PutBytes(ctx, "podhub-slices", "images/a.jpg", "image/jpeg", []byte("jpeg")); err != nil {
		t.Fatal(err)
	}
	keys, err := client.ListKeys(ctx, "podhub-slices")
	if err != nil || len(keys) != 1 || keys[0] != "images/a.jpg" {
		t.Fatalf("listed %v %v", keys, err)
	}
	n, failed, err := client.DeleteKeys(ctx, "podhub-slices", []string{"images/a.jpg"})
	if err != nil || n != 1 || len(failed) != 0 {
		t.Fatalf("delete %d %v %v", n, failed, err)
	}
	keys, err = client.ListKeys(ctx, "podhub-slices")
	if err != nil || len(keys) != 0 {
		t.Fatalf("after delete %v %v", keys, err)
	}

	t.Setenv("CLOUD_MEDIA_GC_DELETE", "0")
	off, err := New(config.Load())
	if err != nil {
		t.Fatal(err)
	}
	if err := off.PutBytes(ctx, "podhub-slices", "images/b.jpg", "image/jpeg", []byte("keep")); err != nil {
		t.Fatal(err)
	}
	if err := off.DeleteObject(ctx, "images/b.jpg"); err != ErrDeleteDisabled {
		t.Fatalf("disabled delete %v", err)
	}
	keys, err = off.ListKeys(ctx, "podhub-slices")
	if err != nil || len(keys) != 1 || keys[0] != "images/b.jpg" {
		t.Fatalf("object must remain %v %v", keys, err)
	}
}

func newFake(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(gofakes3.New(s3mem.New()).Server())
	t.Cleanup(srv.Close)
	if !strings.HasPrefix(srv.URL, "http://127.0.0.1:") {
		t.Fatalf("fake bucket must bind 127.0.0.1, got %s", srv.URL)
	}
	return srv
}
