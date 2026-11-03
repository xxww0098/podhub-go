package app

import (
	"errors"
	"strings"

	admindomain "github.com/xxww0098/podhub-go/internal/admin/domain"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

var errR2NotConfigured = errors.New("R2 storage is not configured")

// configuredStorage validates the complete environment roster before use.
func configuredStorage(cfg config.Config) ([]admindomain.CloudAccount, error) {
	accounts := make([]admindomain.CloudAccount, 0, len(cfg.R2Storage))
	roles, ids := map[string]bool{}, map[string]bool{}
	physicalBuckets := map[string]bool{}
	for _, row := range cfg.R2Storage {
		if row.Role == string(media.RoleTransit) {
			return nil, errors.New("slice storage must be configured by the user")
		}
		if roles[row.Role] || ids[row.ID] || !admindomain.AIID(row.ID) {
			return nil, errors.New("R2 storage role or account ID is invalid")
		}
		roles[row.Role], ids[row.ID] = true, true
		role := media.Role(row.Role)
		name, publicBase := strings.TrimSpace(row.Bucket), strings.TrimSpace(row.PublicBaseURL)
		if name == "" {
			name = media.BucketName(role)
		}
		if publicBase == "" && name == media.BucketName(role) {
			publicBase = media.PublicHost(role)
		}
		bucket := media.Config{
			Role: role, Provider: "cloudflare", Endpoint: row.Endpoint, Region: "auto",
			Bucket: name, PublicBaseURL: publicBase, ForcePathStyle: true,
			KeyPrefix: row.KeyPrefix, AccessKeyID: row.AccessKeyID, SecretAccessKey: row.SecretAccessKey, SessionToken: row.SessionToken,
		}
		if err := bucket.Validate(); err != nil {
			return nil, err
		}
		physical := media.EndpointHost(bucket.Endpoint) + "\x00" + bucket.Bucket
		if physicalBuckets[physical] {
			return nil, errors.New("R2 storage roles must use separate physical buckets")
		}
		physicalBuckets[physical] = true
		prefix, _ := media.NormalizePrefix(bucket.KeyPrefix)
		accounts = append(accounts, admindomain.CloudAccount{
			ID: row.ID, Role: row.Role, Provider: bucket.Provider, Endpoint: bucket.Endpoint, Region: bucket.Region,
			Bucket: bucket.Bucket, KeyPrefix: prefix, PublicBaseURL: bucket.PublicBaseURL, ForcePathStyle: true,
			AccessKeyID: row.AccessKeyID, SecretAccessKey: row.SecretAccessKey, SessionToken: row.SessionToken, Active: true,
		})
	}
	return accounts, nil
}

func configuredR2Account(cfg config.Config, role media.Role) (sign.Account, error) {
	accounts, err := configuredStorage(cfg)
	if err != nil {
		return sign.Account{}, err
	}
	for _, row := range accounts {
		if row.Role == string(role) {
			return sign.Account{
				ID: row.ID, Provider: sign.Provider(row.Provider), Endpoint: row.Endpoint, Region: row.Region,
				Bucket: row.Bucket, KeyPrefix: row.KeyPrefix, PublicBaseURL: row.PublicBaseURL, ForcePathStyle: row.ForcePathStyle,
				AccessKeyID: row.AccessKeyID, SecretAccessKey: row.SecretAccessKey, SessionToken: row.SessionToken,
			}, nil
		}
	}
	return sign.Account{}, errR2NotConfigured
}
