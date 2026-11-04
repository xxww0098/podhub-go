package config

import "testing"

func TestOldSystemBucketEnvironmentDoesNotConfigureFakePurge(t *testing.T) {
	for _, key := range []string{envR2Endpoint, envR2Bucket, envR2AccessKeyID, envR2Secret} {
		t.Setenv(key, "")
	}
	t.Setenv(envMediaGCDelete, "0")
	t.Setenv("R2_ASSETS_ACCESS_KEY_ID", "old-access")
	t.Setenv("R2_PRIVATE_ACCESS_KEY_ID", "old-private-access")
	if cfg := Load(); cfg.R2Configured() || cfg.MediaDeleteEnabled() {
		t.Fatal("old system bucket environment configured fake-bucket purge")
	}
}
