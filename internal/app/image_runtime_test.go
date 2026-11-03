package app

import (
	"testing"

	media "github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
)

func TestImageRuntimeStoredURLsUseConfiguredBucket(t *testing.T) {
	account := storageFixture("assets")
	account.Bucket = "podhub-test-supplier"
	account.PublicBaseURL = "https://pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev"
	identity, err := (media.Config{Endpoint: account.Endpoint, Bucket: account.Bucket, KeyPrefix: account.KeyPrefix}).Identity()
	if err != nil {
		t.Fatal(err)
	}
	// Reading saved images needs the storage environment, not a configured AI model.
	runtime := newImageRuntime(nil, config.Config{R2Storage: []config.R2StorageAccount{account}})
	got, err := runtime.PublicURL(identity, "existing/prefix/image 1.jpg")
	if err != nil || got != account.PublicBaseURL+"/existing/prefix/image%201.jpg" {
		t.Fatalf("stored public URL = %q, %v", got, err)
	}
	for _, tc := range []struct {
		name string
		edit func(*config.R2StorageAccount)
	}{
		{"different bucket", func(a *config.R2StorageAccount) { a.Bucket = "different-test-bucket" }},
		{"different account", func(a *config.R2StorageAccount) { a.Endpoint = "https://other.r2.cloudflarestorage.com" }},
		{"different prefix", func(a *config.R2StorageAccount) { a.KeyPrefix = "other/prefix" }},
		{"missing public URL", func(a *config.R2StorageAccount) { a.PublicBaseURL = "" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			changed := account
			tc.edit(&changed)
			runtime := newImageRuntime(nil, config.Config{R2Storage: []config.R2StorageAccount{changed}})
			if got, err := runtime.PublicURL(identity, "existing/prefix/image.jpg"); err == nil || got != "" {
				t.Fatalf("changed storage exposed an old object: %q, %v", got, err)
			}
		})
	}
	if got, err := newImageRuntime(nil, config.Config{}).PublicURL(identity, "existing/prefix/image.jpg"); err == nil || got != "" {
		t.Fatalf("unconfigured storage exposed an old object: %q, %v", got, err)
	}
}
