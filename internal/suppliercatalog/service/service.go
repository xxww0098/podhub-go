// Package catalogservice is the supplier catalogue manager's business layer.
package catalogservice

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/suppliercatalog/contract"
)

// Repo is the data seam.
type Repo interface {
	Sources(ctx context.Context, userID int64) (contract.SourceListData, error)
}

// Service wraps the repository.
type Service struct{ repo Repo }

// New builds a Service.
func New(repo Repo) Service { return Service{repo: repo} }

// Sources lists the sources this manager may maintain.
func (s Service) Sources(ctx context.Context, userID int64) (contract.SourceListData, error) {
	return s.repo.Sources(ctx, userID)
}
