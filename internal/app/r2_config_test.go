package app

import (
	"testing"

	admindomain "github.com/xxww0098/podhub-go/internal/admin/domain"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
)

func storageFixture(role string) admindomain.StoredStorage {
	return admindomain.StoredStorage{
		ID: "existing_" + role, Role: role, Endpoint: "https://account.r2.cloudflarestorage.com",
		AccessKeyID: "test-key", SecretAccessKey: "test-secret", KeyPrefix: "existing/prefix",
	}
}

func TestSystemStorageValidation(t *testing.T) {
	assets, private := storageFixture("assets"), storageFixture("private")
	accounts, err := admindomain.SystemStorage([]admindomain.StoredStorage{assets, private})
	if err != nil || len(accounts) != 2 || accounts[0].Bucket != media.BucketAssets || accounts[0].PublicBaseURL != media.PublicHostAssets || accounts[1].Bucket != media.BucketPrivate || accounts[1].PublicBaseURL != "" || accounts[0].KeyPrefix != "existing/prefix/" {
		t.Fatalf("storage defaults: %+v %v", accounts, err)
	}
	for _, tc := range []struct {
		name string
		edit func(*admindomain.StoredStorage)
	}{
		{"missing secret", func(a *admindomain.StoredStorage) { a.SecretAccessKey = "" }},
		{"non R2 origin", func(a *admindomain.StoredStorage) { a.Endpoint = "https://example.com" }},
		{"loopback origin", func(a *admindomain.StoredStorage) { a.Endpoint = "http://127.0.0.1:9000" }},
		{"unsafe prefix", func(a *admindomain.StoredStorage) { a.KeyPrefix = "a/../b" }},
		{"unknown role", func(a *admindomain.StoredStorage) { a.Role = "transit" }},
		{"bad ID", func(a *admindomain.StoredStorage) { a.ID = "invalid/id" }},
		{"duplicate ID", func(a *admindomain.StoredStorage) { a.ID = assets.ID }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := private
			tc.edit(&bad)
			if accounts, err := admindomain.SystemStorage([]admindomain.StoredStorage{assets, bad}); err == nil || accounts != nil {
				t.Fatal("invalid roster accepted")
			}
		})
	}
	if _, err := admindomain.SystemStorage([]admindomain.StoredStorage{assets, assets}); err == nil {
		t.Fatal("duplicate role accepted")
	}
	assets.Bucket, private.Bucket = "shared-test-bucket", "shared-test-bucket"
	assets.PublicBaseURL = "https://pub-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.dev"
	private.Endpoint = "https://ACCOUNT.r2.cloudflarestorage.com/"
	if _, err := admindomain.SystemStorage([]admindomain.StoredStorage{assets, private}); err == nil {
		t.Fatal("shared physical bucket accepted")
	}
	assets.Bucket = "podhub-test-supplier"
	if _, err := admindomain.SystemStorage([]admindomain.StoredStorage{assets, private}); err != nil {
		t.Fatalf("development buckets: %v", err)
	}
	assets.PublicBaseURL = ""
	if _, err := admindomain.SystemStorage([]admindomain.StoredStorage{assets, private}); err != media.ErrPublicHost {
		t.Fatalf("missing test public URL: %v", err)
	}
}
