package integration

import (
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

func setR2StorageAccount(t *testing.T, account config.R2StorageAccount) {
	t.Helper()
	prefix := "R2_" + strings.ToUpper(account.Role) + "_"
	for name, value := range map[string]string{
		"ID": account.ID, "ENDPOINT": account.Endpoint,
		"BUCKET": account.Bucket, "PUBLIC_BASE_URL": account.PublicBaseURL,
		"ACCESS_KEY_ID": account.AccessKeyID, "SECRET_ACCESS_KEY": account.SecretAccessKey,
		"SESSION_TOKEN": account.SessionToken, "KEY_PREFIX": account.KeyPrefix,
	} {
		t.Setenv(prefix+name, value)
	}
}
