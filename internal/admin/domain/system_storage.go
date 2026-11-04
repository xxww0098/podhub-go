package domain

import (
	"errors"
	"strings"

	media "github.com/xxww0098/podhub-go/internal/media/contract"
)

// SystemStorage validates the complete roster and resolves its defaults.
func SystemStorage(rows []StoredStorage) ([]CloudAccount, error) {
	accounts := make([]CloudAccount, 0, len(rows))
	roles, ids, physicalBuckets := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, row := range rows {
		if row.Role != string(media.RoleAssets) && row.Role != string(media.RolePrivate) {
			return nil, media.ErrRole
		}
		if roles[row.Role] || ids[row.ID] || !AIID(row.ID) {
			return nil, errors.New("R2 存储桶角色或账号标识无效")
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
			KeyPrefix: row.KeyPrefix, AccessKeyID: row.AccessKeyID, SecretAccessKey: row.SecretAccessKey,
		}
		if err := bucket.Validate(); err != nil {
			return nil, err
		}
		physical := media.EndpointHost(bucket.Endpoint) + "\x00" + bucket.Bucket
		if physicalBuckets[physical] {
			return nil, errors.New("素材桶和私有桶必须使用不同的物理存储桶")
		}
		physicalBuckets[physical] = true
		prefix, _ := media.NormalizePrefix(bucket.KeyPrefix)
		accounts = append(accounts, CloudAccount{
			ID: row.ID, Role: row.Role, Provider: bucket.Provider, Endpoint: bucket.Endpoint, Region: bucket.Region,
			Bucket: bucket.Bucket, KeyPrefix: prefix, PublicBaseURL: bucket.PublicBaseURL, ForcePathStyle: true,
			AccessKeyID: row.AccessKeyID, SecretAccessKey: row.SecretAccessKey, Active: true,
		})
	}
	return accounts, nil
}
