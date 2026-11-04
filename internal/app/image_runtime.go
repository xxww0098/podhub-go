package app

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	configdoc "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/ai"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	registry "github.com/xxww0098/podhub-go/internal/media/service/registry"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

// imageModel is the only model the Bailian generator can drive.
const imageModel = "qwen-image-2.1-pro"

// selectImageAccount picks the one active image-purpose account. The generator
// is Bailian-only today, so the account's model must also be imageModel.
func selectImageAccount(snapshot configdoc.Snapshot) (*configdoc.StoredAI, error) {
	var account *configdoc.StoredAI
	for i := range snapshot.AIAccounts {
		row := &snapshot.AIAccounts[i]
		if row.Active && row.Purpose == configdoc.PurposeImage && row.Model == imageModel && row.APIKey != "" {
			if account != nil {
				return nil, errors.New("ambiguous image account")
			}
			account = row
		}
	}
	if account == nil {
		return nil, errors.New("image model not configured")
	}
	return account, nil
}

// The model and system storage come from the encrypted snapshot.
func newImageRuntime(pool *pgxpool.Pool, cfg config.Config) *ai.ImageRuntime {
	load := func(ctx context.Context) (*configdoc.StoredAI, registry.Account, error) {
		snapshot, err := requireAISnapshot(ctx, pool, cfg)
		if err != nil {
			return nil, registry.Account{}, err
		}
		account, err := selectImageAccount(snapshot)
		if err != nil {
			return nil, registry.Account{}, err
		}
		if _, err = ai.ImageEndpoint(account.BaseURL); err != nil {
			return nil, registry.Account{}, err
		}
		stored, _, err := configuredR2Account(ctx, pool, cfg, media.RoleAssets)
		if err != nil {
			return nil, registry.Account{}, err
		}
		bucket := registry.Account{ID: stored.ID, Provider: string(stored.Provider), Endpoint: stored.Endpoint, Region: stored.Region, Bucket: stored.Bucket, KeyPrefix: stored.KeyPrefix, PublicBaseURL: stored.PublicBaseURL, ForcePathStyle: stored.ForcePathStyle, AccessKeyID: stored.AccessKeyID, SecretAccessKey: stored.SecretAccessKey, SessionToken: stored.SessionToken}
		return account, bucket, nil
	}
	return &ai.ImageRuntime{
		PublicURL: func(ctx context.Context, identity, key string) (string, error) {
			account, _, err := configuredR2Account(ctx, pool, cfg, media.RoleAssets)
			if err != nil {
				return "", err
			}
			current, err := (media.Config{Endpoint: account.Endpoint, Bucket: account.Bucket, KeyPrefix: account.KeyPrefix}).Identity()
			if err != nil || current != identity {
				return "", errors.New("image storage configuration changed")
			}
			return sign.PublicURL(account, key), nil
		},
		Account: func(ctx context.Context) (string, error) {
			account, _, err := load(ctx)
			if err != nil {
				return "", err
			}
			return account.ID, nil
		},
		Resolve: func(ctx context.Context, accountID, model string) (ai.ImageGenerator, ai.ImageAssets, error) {
			account, bucket, err := load(ctx)
			if err != nil {
				return nil, nil, err
			}
			if account.ID != accountID || account.Model != model {
				return nil, nil, errors.New("image model not configured")
			}
			endpoint, err := ai.ImageEndpoint(account.BaseURL)
			if err != nil {
				return nil, nil, err
			}
			return ai.NewBailianImageGenerator(endpoint, model, account.APIKey, ai.ImageNetworkClient()), NewRegistryImageAssets(pool, bucket, nil), nil
		},
	}
}

func imageRuntimeTx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	tx, err := tenantx.BeginApp(ctx, pool.Begin, 0)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
