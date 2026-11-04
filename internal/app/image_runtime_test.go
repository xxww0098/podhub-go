package app

import (
	"encoding/json"
	"testing"

	configdoc "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
)

func TestImageRuntimeStoredURLsUseConfiguredBucket(t *testing.T) {
	ctx, pool := snapshotPool(t)
	cfg := config.Config{IntegrationConfigKey: snapshotTestKey}
	setAccount := func(account configdoc.StoredStorage) {
		raw, err := json.Marshal(configdoc.Snapshot{SchemaVersion: 1, AIRuntime: configdoc.DefaultAIRuntime(), SystemStorage: []configdoc.StoredStorage{account}})
		if err != nil {
			t.Fatal(err)
		}
		storeSnapshot(t, ctx, pool, raw)
	}
	account := storageFixture("assets")
	account.Bucket = "podhub-test-supplier"
	account.PublicBaseURL = "https://pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev"
	identity, err := (media.Config{Endpoint: account.Endpoint, Bucket: account.Bucket, KeyPrefix: account.KeyPrefix}).Identity()
	if err != nil {
		t.Fatal(err)
	}
	// Reading saved images needs the stored bucket, not a configured AI model.
	setAccount(account)
	runtime := newImageRuntime(pool, cfg)
	got, err := runtime.PublicURL(ctx, identity, "existing/prefix/image 1.jpg")
	if err != nil || got != account.PublicBaseURL+"/existing/prefix/image%201.jpg" {
		t.Fatalf("stored public URL = %q, %v", got, err)
	}
	for _, tc := range []struct {
		name string
		edit func(*configdoc.StoredStorage)
	}{
		{"different bucket", func(a *configdoc.StoredStorage) { a.Bucket = "different-test-bucket" }},
		{"different account", func(a *configdoc.StoredStorage) { a.Endpoint = "https://other.r2.cloudflarestorage.com" }},
		{"different prefix", func(a *configdoc.StoredStorage) { a.KeyPrefix = "other/prefix" }},
		{"missing public URL", func(a *configdoc.StoredStorage) { a.PublicBaseURL = "" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			changed := account
			tc.edit(&changed)
			setAccount(changed)
			if got, err := runtime.PublicURL(ctx, identity, "existing/prefix/image.jpg"); err == nil || got != "" {
				t.Fatalf("changed storage exposed an old object: %q, %v", got, err)
			}
		})
	}
	if got, err := newImageRuntime(nil, config.Config{}).PublicURL(ctx, identity, "existing/prefix/image.jpg"); err == nil || got != "" {
		t.Fatalf("unconfigured storage exposed an old object: %q, %v", got, err)
	}
}
