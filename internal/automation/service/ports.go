// Package service is the automation use-case layer.
package service

import (
	"context"
	"encoding/json"

	"github.com/xxww0098/podhub-go/internal/automation/domain"
)

// Store is the SQL the handlers need. HTTP does not import the repo.
type Store interface {
	ListAssetSets(ctx context.Context, orgID, userID int64) ([]domain.AssetSet, error)
	CreateAssetSet(ctx context.Context, orgID, userID int64, name string, items []domain.ItemInput) (domain.AssetSet, error)
	Claim(ctx context.Context, orgID, userID int64, runtimeID string, limit int64) ([]domain.Claimed, error)
	Renew(ctx context.Context, orgID, userID int64, runtimeID string, ids []string, epochs []int64) ([]domain.RenewHit, error)
	Progress(ctx context.Context, orgID, userID int64, id string, epoch int64, progress json.RawMessage) (domain.WriteResult, error)
	Settle(ctx context.Context, orgID, userID int64, id string, epoch int64, status string, result, errJSON *json.RawMessage) (domain.WriteResult, error)
	ListGrants(ctx context.Context, userID, orgID int64) ([]domain.GrantView, error)
	CreateGrant(ctx context.Context, userID, orgID int64, name, tokenHash, tokenPrefix string, actions []string, expiresDays *int64) (domain.GrantView, error)
	RevokeGrant(ctx context.Context, userID, orgID int64, id string) (string, error)
	ListRuntimes(ctx context.Context, orgID, userID int64) ([]domain.RuntimeRow, error)
	RegisterRuntime(ctx context.Context, orgID, userID int64, grantID, label, renderer string) (domain.RuntimeRow, error)
	DeregisterRuntime(ctx context.Context, orgID, userID int64, id string) (domain.RuntimeRow, error)
	HeartbeatRuntime(ctx context.Context, orgID, userID int64, id string) (domain.RuntimeRow, error)
}
