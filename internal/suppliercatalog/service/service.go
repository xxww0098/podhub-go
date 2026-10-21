// Package catalogservice is the supplier catalogue manager's business layer.
package catalogservice

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/suppliercatalog/contract"
)

// Repo is the data seam.
type Repo interface {
	Sources(ctx context.Context, userID int64) (contract.SourceListData, error)
	Detail(ctx context.Context, userID int64, sourceID string) (contract.SourceDetail, error)
	Rows(ctx context.Context, userID int64, sourceID string) (contract.RowListData, error)
	Row(ctx context.Context, userID int64, sourceID, productID string) (contract.CatalogRow, error)
	CreateRow(ctx context.Context, userID int64, sourceID string, in contract.RowInput, now int64) (contract.CatalogRow, error)
	UpdateRow(ctx context.Context, userID int64, sourceID, productID string, in contract.RowInput, now int64) (contract.CatalogRow, error)
	SetPublished(ctx context.Context, userID int64, sourceID, productID string, on bool, now int64) (contract.CatalogRow, error)
	DeleteRow(ctx context.Context, userID int64, sourceID, productID string, now int64) error
}

// Service wraps the repository.
type Service struct{ repo Repo }

// New builds a Service.
func New(repo Repo) Service { return Service{repo: repo} }

// Sources lists the sources this manager may maintain.
func (s Service) Sources(ctx context.Context, userID int64) (contract.SourceListData, error) {
	return s.repo.Sources(ctx, userID)
}

// Detail reads one source with its prop definitions and rows.
func (s Service) Detail(ctx context.Context, userID int64, sourceID string) (contract.SourceDetail, error) {
	return s.repo.Detail(ctx, userID, sourceID)
}

// Rows lists the rows of one source.
func (s Service) Rows(ctx context.Context, userID int64, sourceID string) (contract.RowListData, error) {
	return s.repo.Rows(ctx, userID, sourceID)
}

// Row reads one row.
func (s Service) Row(ctx context.Context, userID int64, sourceID, productID string) (contract.CatalogRow, error) {
	return s.repo.Row(ctx, userID, sourceID, productID)
}

// CreateRow adds a row.
func (s Service) CreateRow(ctx context.Context, userID int64, sourceID string, in contract.RowInput, now int64) (contract.CatalogRow, error) {
	return s.repo.CreateRow(ctx, userID, sourceID, in, now)
}

// UpdateRow edits a row.
func (s Service) UpdateRow(ctx context.Context, userID int64, sourceID, productID string, in contract.RowInput, now int64) (contract.CatalogRow, error) {
	return s.repo.UpdateRow(ctx, userID, sourceID, productID, in, now)
}

// SetPublished flips the publish flag after the readiness gate.
func (s Service) SetPublished(ctx context.Context, userID int64, sourceID, productID string, on bool, now int64) (contract.CatalogRow, error) {
	return s.repo.SetPublished(ctx, userID, sourceID, productID, on, now)
}

// DeleteRow archives a row.
func (s Service) DeleteRow(ctx context.Context, userID int64, sourceID, productID string, now int64) error {
	return s.repo.DeleteRow(ctx, userID, sourceID, productID, now)
}
