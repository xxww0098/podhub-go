package app

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
	admindomain "github.com/xxww0098/podhub-go/internal/admin/domain"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

var errR2NotConfigured = errors.New("R2 storage is not configured")

func configuredStorage(ctx context.Context, pool *pgxpool.Pool, cfg config.Config) ([]admindomain.CloudAccount, int64, error) {
	snapshot, revision, found, err := loadSnapshot(ctx, pool, cfg)
	if err != nil {
		return nil, 0, err
	}
	if !found {
		return nil, 0, nil
	}
	accounts, err := admindomain.SystemStorage(snapshot.SystemStorage)
	return accounts, revision, err
}

func configuredR2Account(ctx context.Context, pool *pgxpool.Pool, cfg config.Config, role media.Role) (sign.Account, int64, error) {
	accounts, revision, err := configuredStorage(ctx, pool, cfg)
	if err != nil {
		return sign.Account{}, 0, err
	}
	for _, row := range accounts {
		if row.Role == string(role) {
			return sign.Account{
				ID: row.ID, Provider: sign.Provider(row.Provider), Endpoint: row.Endpoint, Region: row.Region,
				Bucket: row.Bucket, KeyPrefix: row.KeyPrefix, PublicBaseURL: row.PublicBaseURL, ForcePathStyle: row.ForcePathStyle,
				AccessKeyID: row.AccessKeyID, SecretAccessKey: row.SecretAccessKey, SessionToken: row.SessionToken,
			}, revision, nil
		}
	}
	return sign.Account{}, 0, errR2NotConfigured
}
