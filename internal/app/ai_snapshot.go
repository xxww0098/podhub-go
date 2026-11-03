package app

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	configdoc "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/ai"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

// loadAISnapshot reads and opens the platform integration snapshot. found is
// false only when no configuration row exists. A present row that cannot be
// read, decrypted, or parsed is an error.
func loadAISnapshot(ctx context.Context, pool *pgxpool.Pool, cfg config.Config) (snapshot configdoc.Snapshot, found bool, err error) {
	if pool == nil {
		return snapshot, false, errors.New("integration configuration missing")
	}
	key, err := seal.IntegrationKEK(cfg.IntegrationConfigKey)
	if err != nil {
		return snapshot, false, err
	}
	var nonce, ciphertext []byte
	err = imageRuntimeTx(ctx, pool, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT nonce,ciphertext FROM platform_integration_config WHERE singleton=true`).Scan(&nonce, &ciphertext)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return snapshot, false, nil
	}
	if err != nil {
		return snapshot, false, err
	}
	plain, err := seal.OpenIntegration(key, nonce, ciphertext)
	if err != nil {
		return snapshot, false, err
	}
	snapshot, _, err = configdoc.ParseStored(plain)
	if err != nil {
		return configdoc.Snapshot{}, false, err
	}
	return snapshot, true, nil
}

// requireAISnapshot is loadAISnapshot for runtimes that cannot work without a row.
func requireAISnapshot(ctx context.Context, pool *pgxpool.Pool, cfg config.Config) (configdoc.Snapshot, error) {
	snapshot, found, err := loadAISnapshot(ctx, pool, cfg)
	if err != nil {
		return configdoc.Snapshot{}, err
	}
	if !found {
		return configdoc.Snapshot{}, errors.New("integration configuration missing")
	}
	return snapshot, nil
}

// aiLimits is the per-request ceiling source for the relay. No row means every
// ceiling is off with the default lease; an unreadable row is an error so the
// request fails closed.
func aiLimits(pool *pgxpool.Pool, cfg config.Config) func(context.Context) (ai.Limits, error) {
	return func(ctx context.Context) (ai.Limits, error) {
		snapshot, found, err := loadAISnapshot(ctx, pool, cfg)
		if err != nil {
			return ai.Limits{}, err
		}
		runtime := configdoc.DefaultAIRuntime()
		if found {
			runtime = snapshot.AIRuntime
		}
		return limitsOf(runtime), nil
	}
}

func limitsOf(runtime configdoc.AIRuntime) ai.Limits {
	lease := runtime.LeaseTTLSeconds
	if lease < 1 {
		lease = configdoc.DefaultLeaseTTLSeconds
	}
	return ai.Limits{
		Global:    uint32(max(runtime.MaxConcurrencyGlobal, 0)),
		User:      uint32(max(runtime.MaxConcurrencyUser, 0)),
		Account:   uint32(max(runtime.MaxConcurrencyAccount, 0)),
		PerMinute: uint32(max(runtime.UserRatePerMinute, 0)),
		LeaseTTL:  time.Duration(lease) * time.Second,
	}
}
