package config

import (
	"os"
	"strings"
)

// R2StorageAccount is process configuration; bucket rules are validated by the consumer.
type R2StorageAccount struct {
	ID              string
	Role            string
	Endpoint        string
	Bucket          string
	PublicBaseURL   string
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	KeyPrefix       string
}

func loadR2Storage() []R2StorageAccount {
	var accounts []R2StorageAccount
	for _, role := range []string{"assets", "private"} {
		prefix := "R2_" + strings.ToUpper(role) + "_"
		account := R2StorageAccount{
			ID:              strings.TrimSpace(os.Getenv(prefix + "ID")),
			Endpoint:        strings.TrimSpace(os.Getenv(prefix + "ENDPOINT")),
			Bucket:          strings.TrimSpace(os.Getenv(prefix + "BUCKET")),
			PublicBaseURL:   strings.TrimSpace(os.Getenv(prefix + "PUBLIC_BASE_URL")),
			AccessKeyID:     strings.TrimSpace(os.Getenv(prefix + "ACCESS_KEY_ID")),
			SecretAccessKey: strings.TrimSpace(os.Getenv(prefix + "SECRET_ACCESS_KEY")),
			SessionToken:    strings.TrimSpace(os.Getenv(prefix + "SESSION_TOKEN")),
			KeyPrefix:       strings.TrimSpace(os.Getenv(prefix + "KEY_PREFIX")),
		}
		if account == (R2StorageAccount{}) {
			continue
		}
		account.Role = role
		if account.ID == "" {
			account.ID = "s3_" + role
		}
		accounts = append(accounts, account)
	}
	return accounts
}
