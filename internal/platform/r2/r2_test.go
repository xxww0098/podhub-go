package r2

import (
	"context"
	"os"
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

func TestUnsetDeleteIsEnabledButDoesNotDial(t *testing.T) {
	t.Setenv("CLOUD_MEDIA_GC_DELETE", "sentinel")
	os.Unsetenv("CLOUD_MEDIA_GC_DELETE")
	clearR2(t)
	client, err := New(config.Load())
	if err != nil {
		t.Fatal(err)
	}
	if err := client.DeleteObject(context.Background(), "slices/x"); err != ErrDeleteNotPorted {
		t.Fatalf("got %v", err)
	}
}

func TestExplicitOffDoesNotDelete(t *testing.T) {
	for _, value := range []string{"0", "false", "off", "no", "", "maybe"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("CLOUD_MEDIA_GC_DELETE", value)
			clearR2(t)
			client, err := New(config.Load())
			if err != nil {
				t.Fatal(err)
			}
			if err := client.DeleteObject(context.Background(), "slices/x"); err != ErrDeleteDisabled {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestCredentialsWithDeleteEnabledAreRefused(t *testing.T) {
	t.Setenv("CLOUD_MEDIA_GC_DELETE", "1")
	t.Setenv("R2_ENDPOINT", "https://example.r2.cloudflarestorage.com")
	t.Setenv("R2_BUCKET", "podhub-slices")
	t.Setenv("R2_ACCESS_KEY_ID", "test")
	t.Setenv("R2_SECRET_ACCESS_KEY", "test")
	client, err := New(config.Load())
	if err != ErrRewriteBucketRefuse {
		t.Fatalf("got client=%v err=%v", client, err)
	}
}

func TestCredentialsWhileDeleteOffDoNotCallR2(t *testing.T) {
	t.Setenv("CLOUD_MEDIA_GC_DELETE", "0")
	t.Setenv("R2_ENDPOINT", "https://example.r2.cloudflarestorage.com")
	t.Setenv("R2_BUCKET", "podhub-slices")
	t.Setenv("R2_ACCESS_KEY_ID", "test")
	t.Setenv("R2_SECRET_ACCESS_KEY", "test")
	client, err := New(config.Load())
	if err != nil {
		t.Fatal(err)
	}
	if !client.Configured() {
		t.Fatal("placeholder client should be constructed while the purge is off")
	}
	if err := client.DeleteObject(context.Background(), "slices/x"); err != ErrDeleteDisabled {
		t.Fatalf("got %v", err)
	}
	if _, _, err := client.DeleteKeys(context.Background(), "podhub-slices", []string{"slices/x"}); err != ErrDeleteDisabled {
		t.Fatalf("keys %v", err)
	}
}

func clearR2(t *testing.T) {
	t.Helper()
	t.Setenv("R2_ENDPOINT", "")
	t.Setenv("R2_BUCKET", "")
	t.Setenv("R2_ACCESS_KEY_ID", "")
	t.Setenv("R2_SECRET_ACCESS_KEY", "")
}
