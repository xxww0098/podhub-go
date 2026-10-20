package slicepurge

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/johannesboyne/gofakes3"
	"github.com/johannesboyne/gofakes3/backend/s3mem"

	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	storage "github.com/xxww0098/podhub-go/internal/platform/r2"
)

func TestRunDeletesOnlyTheTransitFakeBucket(t *testing.T) {
	srv := httptest.NewServer(gofakes3.New(s3mem.New()).Server())
	t.Cleanup(srv.Close)
	if !strings.HasPrefix(srv.URL, "http://127.0.0.1:") {
		t.Fatalf("endpoint %s", srv.URL)
	}
	t.Setenv("CLOUD_MEDIA_GC_DELETE", "1")
	t.Setenv("R2_ENDPOINT", srv.URL)
	t.Setenv("R2_BUCKET", "podhub-transit")
	t.Setenv("R2_ACCESS_KEY_ID", "test")
	t.Setenv("R2_SECRET_ACCESS_KEY", "test")
	client, err := storage.New(config.Load())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	workspace := "550e8400-e29b-41d4-a716-446655440000"
	digest := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	key, err := objectkey.ComposeKey("", objectkey.ClassImage, workspace, digest, "jpg")
	if err != nil {
		t.Fatal(err)
	}
	for _, bucket := range append(append([]string{}, Buckets...), "podhub-other") {
		if err := client.CreateBucket(ctx, bucket); err != nil {
			t.Fatal(err)
		}
		if err := client.PutBytes(ctx, bucket, key, "image/jpeg", []byte("img")); err != nil {
			t.Fatal(err)
		}
	}
	for _, bucket := range Buckets {
		report := Run(ctx, &memStore{remaining: time.Hour}, BucketOrigin{Client: client, Bucket: bucket}, func(time.Duration) {})
		if !report.Completed || report.DeletedAck != 1 || report.StopCode != "empty_observed" {
			t.Fatalf("%s %+v", bucket, report)
		}
		left, err := client.ListKeys(ctx, bucket)
		if err != nil || len(left) != 0 {
			t.Fatalf("%s still has %v %v", bucket, left, err)
		}
	}
	left, err := client.ListKeys(ctx, "podhub-other")
	if err != nil || len(left) != 1 || left[0] != key {
		t.Fatalf("other bucket %v %v", left, err)
	}
}
