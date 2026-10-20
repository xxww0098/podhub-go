package ozonerrsvc

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/ozonerr/domain"
)

// Store is the catalog write and read port. The repo implements it.
type Store interface {
	Insert(ctx context.Context, orgID int64, rows []domain.Row) (int, error)
	InsertRequest(ctx context.Context, orgID int64, intentID, code, sample, taskKey string) error
	ListGlobal(ctx context.Context, userID int64, q domain.Query) ([]domain.Entry, error)
	ListOrg(ctx context.Context, orgID int64, q domain.Query) ([]domain.Entry, error)
}
