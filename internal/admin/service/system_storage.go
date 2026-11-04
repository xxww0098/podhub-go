package service

import (
	"strings"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
)

// StorageIn is the five-field R2 configuration the admin form submits.
// Identity, key prefix and session token are internal: they are derived for a
// new bucket and retained when an existing bucket is edited.
type StorageIn struct {
	Role, Endpoint, Bucket, PublicBaseURL string
	AccessKeyID, SecretAccessKey          string
}

type storageView struct {
	Role          string `json:"role"`
	Endpoint      string `json:"endpoint"`
	Bucket        string `json:"bucket"`
	PublicBaseURL string `json:"public_base_url"`
}

func storageViews(rows []domain.StoredStorage) []storageView {
	views := make([]storageView, 0, len(rows))
	for _, row := range rows {
		views = append(views, storageView{row.Role, row.Endpoint, row.Bucket, row.PublicBaseURL})
	}
	return views
}

func mergeSystemStorage(old *domain.Snapshot, rows []StorageIn) ([]domain.StoredStorage, *contract.Fault) {
	if len(rows) > 2 {
		return nil, contract.Validation("系统存储最多配置两个桶")
	}
	result := make([]domain.StoredStorage, 0, len(rows))
	for _, input := range rows {
		row := domain.StoredStorage{
			Role: strings.TrimSpace(input.Role), Endpoint: strings.TrimSpace(input.Endpoint),
			Bucket: strings.TrimSpace(input.Bucket), PublicBaseURL: strings.TrimSpace(input.PublicBaseURL),
			AccessKeyID: strings.TrimSpace(input.AccessKeyID), SecretAccessKey: strings.TrimSpace(input.SecretAccessKey),
		}
		row.ID = "s3_" + row.Role
		role := media.Role(row.Role)
		if row.Bucket == "" {
			row.Bucket = media.BucketName(role)
		}
		if row.PublicBaseURL == "" && row.Bucket == media.BucketName(role) {
			row.PublicBaseURL = media.PublicHost(role)
		}
		var previous *domain.StoredStorage
		if old != nil {
			for i := range old.SystemStorage {
				if old.SystemStorage[i].Role == row.Role {
					previous = &old.SystemStorage[i]
					break
				}
			}
		}
		if previous != nil {
			row.ID, row.KeyPrefix = previous.ID, previous.KeyPrefix
			previousBucket := previous.Bucket
			if previousBucket == "" {
				previousBucket = media.BucketName(media.Role(previous.Role))
			}
			if strings.EqualFold(strings.TrimRight(previous.Endpoint, "/"), strings.TrimRight(row.Endpoint, "/")) && previousBucket == row.Bucket {
				if row.AccessKeyID == "" {
					row.AccessKeyID = previous.AccessKeyID
				}
				if row.SecretAccessKey == "" && row.AccessKeyID == previous.AccessKeyID {
					row.SecretAccessKey = previous.SecretAccessKey
				}
			}
		}
		if len(row.AccessKeyID) > 1024 || len(row.SecretAccessKey) > 1024 {
			return nil, contract.Validation("存储桶凭据过长")
		}
		result = append(result, row)
	}
	if _, err := domain.SystemStorage(result); err != nil {
		return nil, contract.Validation(err.Error())
	}
	return result, nil
}
