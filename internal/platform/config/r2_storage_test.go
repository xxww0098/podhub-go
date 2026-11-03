package config

import (
	"reflect"
	"strings"
	"testing"
)

func clearR2Storage(t *testing.T) {
	t.Helper()
	for _, role := range []string{"TRANSIT", "ASSETS", "PRIVATE"} {
		for _, field := range []string{"ID", "ENDPOINT", "BUCKET", "PUBLIC_BASE_URL", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "SESSION_TOKEN", "KEY_PREFIX"} {
			t.Setenv("R2_"+role+"_"+field, "")
		}
	}
}

func TestR2StorageLoadRolesAndFreeze(t *testing.T) {
	clearR2Storage(t)
	for _, role := range []string{"TRANSIT", "ASSETS", "PRIVATE"} {
		t.Setenv("R2_"+role+"_ENDPOINT", " https://example.r2.cloudflarestorage.com ")
		t.Setenv("R2_"+role+"_ACCESS_KEY_ID", " access ")
		t.Setenv("R2_"+role+"_SECRET_ACCESS_KEY", " secret ")
	}
	t.Setenv("R2_ASSETS_ID", " existing-assets ")
	t.Setenv("R2_ASSETS_SESSION_TOKEN", " session ")
	t.Setenv("R2_ASSETS_KEY_PREFIX", " dev/ ")
	t.Setenv("R2_ASSETS_BUCKET", " podhub-test-supplier ")
	t.Setenv("R2_ASSETS_PUBLIC_BASE_URL", " https://pub-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.dev ")
	cfg := Load()
	var want []R2StorageAccount
	for _, role := range []string{"assets", "private"} {
		account := R2StorageAccount{ID: "s3_" + role, Role: role, Endpoint: "https://example.r2.cloudflarestorage.com", AccessKeyID: "access", SecretAccessKey: "secret"}
		if role == "assets" {
			account.ID, account.SessionToken, account.KeyPrefix = "existing-assets", "session", "dev/"
			account.Bucket, account.PublicBaseURL = "podhub-test-supplier", "https://pub-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.dev"
		}
		want = append(want, account)
	}
	if !reflect.DeepEqual(cfg.R2Storage, want) {
		t.Fatalf("loaded accounts = %+v, want %+v", cfg.R2Storage, want)
	}
	for _, account := range cfg.R2Storage {
		if account.Role == "transit" {
			t.Fatal("system transit settings must not be loaded")
		}
	}
	clearR2Storage(t)
	if !reflect.DeepEqual(cfg.R2Storage, want) || len(Load().R2Storage) != 0 {
		t.Fatal("loaded configuration must stay fixed until Load is called again")
	}
}

func TestR2StorageKeepsPartialConfiguration(t *testing.T) {
	for _, field := range []string{"ID", "ENDPOINT", "BUCKET", "PUBLIC_BASE_URL", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "SESSION_TOKEN", "KEY_PREFIX"} {
		t.Run(field, func(t *testing.T) {
			clearR2Storage(t)
			t.Setenv("R2_PRIVATE_"+field, " partial ")
			accounts := Load().R2Storage
			if len(accounts) != 1 || accounts[0].Role != "private" {
				t.Fatal("partial configuration must reach consumer validation")
			}
		})
	}
}

func TestR2StorageDoesNotConfigureFakePurge(t *testing.T) {
	clearR2Storage(t)
	for _, key := range []string{envR2Endpoint, envR2Bucket, envR2AccessKeyID, envR2Secret} {
		t.Setenv(key, "")
	}
	t.Setenv(envMediaGCDelete, "0")
	t.Setenv("R2_ASSETS_ACCESS_KEY_ID", "production-access")
	if cfg := Load(); cfg.R2Configured() || cfg.MediaDeleteEnabled() {
		t.Fatal("production storage must not configure or enable fake-bucket purge")
	}
	t.Setenv("R2_ASSETS_ACCESS_KEY_ID", " \t ")
	for _, key := range []string{envR2Endpoint, envR2Bucket, envR2AccessKeyID, envR2Secret} {
		t.Setenv(key, strings.ToLower(key))
	}
	if cfg := Load(); len(cfg.R2Storage) != 0 || !cfg.R2Configured() {
		t.Fatal("fake-bucket configuration must not create production accounts")
	}
}
