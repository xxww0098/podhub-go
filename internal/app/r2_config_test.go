package app

import (
	"context"
	"testing"

	media "github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
)

func storageFixture(role string) config.R2StorageAccount {
	return config.R2StorageAccount{
		ID: "existing_" + role, Role: role, Endpoint: "https://account.r2.cloudflarestorage.com",
		AccessKeyID: "test-key", SecretAccessKey: "test-secret", KeyPrefix: "existing/prefix",
	}
}

func TestConfiguredStorageRoles(t *testing.T) {
	cfg := config.Config{}
	for _, role := range []media.Role{media.RoleAssets, media.RolePrivate} {
		cfg.R2Storage = append(cfg.R2Storage, storageFixture(string(role)))
	}
	accounts, err := configuredStorage(cfg)
	if err != nil || len(accounts) != 2 {
		t.Fatalf("storage count=%d error=%v", len(accounts), err)
	}
	for _, role := range []media.Role{media.RoleAssets, media.RolePrivate} {
		account, err := configuredR2Account(cfg, role)
		if err != nil || account.ID != "existing_"+string(role) || account.Bucket != media.BucketName(role) || account.PublicBaseURL != media.PublicHost(role) || account.KeyPrefix != "existing/prefix/" || account.Region != "auto" || !account.ForcePathStyle {
			t.Fatalf("role %s did not preserve its account and bucket rules: %v", role, err)
		}
	}
	// Private uploads need no database configuration row or integration encryption key.
	edge := delegateEdge(cfg, nil)
	prefix, revision, err := edge.Storage(context.Background())
	if err != nil || prefix != "existing/prefix/" || revision != 1 {
		t.Fatalf("private storage = %q, %d, %v", prefix, revision, err)
	}
}

func TestConfiguredStorageRejectsInvalidRoster(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*config.R2StorageAccount)
	}{
		{"missing secret", func(a *config.R2StorageAccount) { a.SecretAccessKey = "" }},
		{"non R2 origin", func(a *config.R2StorageAccount) { a.Endpoint = "https://example.com" }},
		{"loopback origin", func(a *config.R2StorageAccount) { a.Endpoint = "http://127.0.0.1:9000" }},
		{"unsafe prefix", func(a *config.R2StorageAccount) { a.KeyPrefix = "a/../b" }},
		{"unknown role", func(a *config.R2StorageAccount) { a.Role = "unknown" }},
		{"bad ID", func(a *config.R2StorageAccount) { a.ID = "invalid/id" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := storageFixture("private")
			tc.edit(&bad)
			if accounts, err := configuredStorage(config.Config{R2Storage: []config.R2StorageAccount{storageFixture("assets"), bad}}); err == nil || accounts != nil {
				t.Fatal("invalid roster returned usable storage")
			}
		})
	}
	for _, rows := range [][]config.R2StorageAccount{
		{storageFixture("assets"), storageFixture("assets")},
		{storageFixture("assets"), {ID: "existing_assets", Role: "private"}},
	} {
		if _, err := configuredStorage(config.Config{R2Storage: rows}); err == nil {
			t.Fatal("duplicate role or ID accepted")
		}
	}
	if accounts, err := configuredStorage(config.Config{}); err != nil || len(accounts) != 0 {
		t.Fatal("empty environment should leave storage unconfigured")
	}
	if _, _, err := loadDelegateStorage(config.Config{IntegrationConfigKey: "unrelated-database-key"}); err == nil {
		t.Fatal("missing environment must not fall back to database storage")
	}
	if _, err := configuredStorage(config.Config{R2Storage: []config.R2StorageAccount{storageFixture("transit")}}); err == nil {
		t.Fatal("system transit account must not be accepted")
	}
}

func TestConfiguredStorageDevelopmentBuckets(t *testing.T) {
	rows := []config.R2StorageAccount{storageFixture("assets"), storageFixture("private")}
	rows[0].Bucket, rows[0].PublicBaseURL = "podhub-test-supplier", "https://pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev"
	rows[1].Bucket = "podhub-test-delegate"
	accounts, err := configuredStorage(config.Config{R2Storage: rows})
	if err != nil || len(accounts) != 2 {
		t.Fatalf("development buckets: count=%d err=%v", len(accounts), err)
	}
	for i, account := range accounts {
		if account.Bucket != rows[i].Bucket || account.PublicBaseURL != rows[i].PublicBaseURL {
			t.Fatalf("role %s changed its configured bucket or public URL", rows[i].Role)
		}
	}
	rows[0].PublicBaseURL = ""
	if _, err := configuredStorage(config.Config{R2Storage: rows}); err != media.ErrPublicHost {
		t.Fatalf("non-default bucket without public URL must not use production host: %v", err)
	}
}

func TestConfiguredStorageRejectsSharedPhysicalBucket(t *testing.T) {
	assets, private := storageFixture("assets"), storageFixture("private")
	assets.Bucket, private.Bucket = "shared-test-bucket", "shared-test-bucket"
	assets.PublicBaseURL = "https://pub-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.dev"
	assets.KeyPrefix, private.KeyPrefix = "assets/", "private/"
	private.Endpoint = "https://ACCOUNT.r2.cloudflarestorage.com/"
	if accounts, err := configuredStorage(config.Config{R2Storage: []config.R2StorageAccount{assets, private}}); err == nil || accounts != nil {
		t.Fatal("roles sharing a physical bucket must be refused even with different prefixes")
	}
}
