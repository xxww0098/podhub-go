package worker

import (
	"context"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/johannesboyne/gofakes3"
	"github.com/johannesboyne/gofakes3/backend/s3mem"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	storage "github.com/xxww0098/podhub-go/internal/platform/r2"
)

func TestMediaGCIdleWhenDeleteOff(t *testing.T) {
	t.Setenv("CLOUD_MEDIA_GC_DELETE", "0")
	t.Setenv("DATABASE_URL", "")
	clearR2(t)
	if code := Main(RoleMediaGC); code != 0 {
		t.Fatalf("exit %d", code)
	}
}

func TestMediaGCUnsetDoesNotLookLikeSuccess(t *testing.T) {
	t.Setenv("CLOUD_MEDIA_GC_DELETE", "sentinel")
	os.Unsetenv("CLOUD_MEDIA_GC_DELETE")
	t.Setenv("DATABASE_URL", "")
	clearR2(t)
	if code := Main(RoleMediaGC); code == 0 {
		t.Fatal("unset CLOUD_MEDIA_GC_DELETE enables the purge; exit 0 would look like a successful delete")
	}
}

func TestMediaGCRefusesCredentialedBucket(t *testing.T) {
	t.Setenv("CLOUD_MEDIA_GC_DELETE", "1")
	t.Setenv("R2_ENDPOINT", "https://example.r2.cloudflarestorage.com")
	t.Setenv("R2_BUCKET", "podhub-slices")
	t.Setenv("R2_ACCESS_KEY_ID", "test")
	t.Setenv("R2_SECRET_ACCESS_KEY", "test")
	if code := Main(RoleMediaGC); code == 0 {
		t.Fatal("credentialed bucket plus an enabled purge must fail")
	}
}

func clearR2(t *testing.T) {
	t.Helper()
	t.Setenv("R2_ENDPOINT", "")
	t.Setenv("R2_BUCKET", "")
	t.Setenv("R2_ACCESS_KEY_ID", "")
	t.Setenv("R2_SECRET_ACCESS_KEY", "")
}

func TestMediaGCLoopbackWithoutDatabaseDoesNotDelete(t *testing.T) {
	srv := httptest.NewServer(gofakes3.New(s3mem.New()).Server())
	t.Cleanup(srv.Close)
	if !strings.HasPrefix(srv.URL, "http://127.0.0.1:") {
		t.Fatalf("endpoint %s", srv.URL)
	}
	t.Setenv("CLOUD_MEDIA_GC_DELETE", "1")
	t.Setenv("DATABASE_URL", "")
	t.Setenv("R2_ENDPOINT", srv.URL)
	t.Setenv("R2_BUCKET", "podhub-slices")
	t.Setenv("R2_ACCESS_KEY_ID", "test")
	t.Setenv("R2_SECRET_ACCESS_KEY", "test")
	client, err := storage.New(config.Load())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := client.CreateBucket(ctx, "podhub-slices"); err != nil {
		t.Fatal(err)
	}
	if err := client.PutBytes(ctx, "podhub-slices", "images/keep.jpg", "image/jpeg", []byte("keep")); err != nil {
		t.Fatal(err)
	}
	if code := Main(RoleMediaGC); code == 0 {
		t.Fatal("an enabled purge without slice_r2_cleanup_runs must not look like success")
	}
	keys, err := client.ListKeys(ctx, "podhub-slices")
	if err != nil || len(keys) != 1 || keys[0] != "images/keep.jpg" {
		t.Fatalf("object was deleted without a receipt: %v %v", keys, err)
	}
}

func TestListingRefusesMissingDatabase(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	if code := Main(RoleListing); code == 0 {
		t.Fatal("listing worker must not start without a database")
	}
}

func TestListingRefusesRemoteDatabase(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://ozon:secret@db.internal:5432/ozon_cloud")
	if code := Main(RoleSync); code == 0 {
		t.Fatal("sync worker must refuse a non-loopback database")
	}
}
