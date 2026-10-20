package service

import (
	"context"
	"errors"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// TagDirectory is the repo side of the tag writes. It opens a tenant
// transaction itself, so every statement runs under the org GUC.
type TagDirectory interface {
	Create(ctx context.Context, orgID, userID int64, name string) (domain.Tag, error)
	Rename(ctx context.Context, orgID, userID int64, tagUUID, name string) (domain.Tag, error)
	Delete(ctx context.Context, orgID, userID int64, tagUUID string) (domain.TagDeleted, error)
}

// WithTags sets the tag directory. A nil directory leaves the tag writes
// unavailable instead of panicking.
func (s Service) WithTags(tags TagDirectory) Service {
	s.tags = tags
	return s
}

// CreateTag adds one tag. Only an owner or manager may write.
func (s Service) CreateTag(ctx context.Context, orgID, userID int64, role, name string) (domain.Tag, error) {
	if !access.CanManage(role) {
		return domain.Tag{}, contract.ErrForbidden
	}
	if s.tags == nil {
		return domain.Tag{}, contract.ErrUnavailable
	}
	trimmed, err := domain.ValidTagName(name)
	if err != nil {
		return domain.Tag{}, err
	}
	return s.tags.Create(ctx, orgID, userID, trimmed)
}

// RenameTag sets a new name. Only an owner or manager may write.
func (s Service) RenameTag(ctx context.Context, orgID, userID int64, role, tagUUID, name string) (domain.Tag, error) {
	if !access.CanManage(role) {
		return domain.Tag{}, contract.ErrForbidden
	}
	if s.tags == nil {
		return domain.Tag{}, contract.ErrUnavailable
	}
	trimmed, err := domain.ValidTagName(name)
	if err != nil {
		return domain.Tag{}, err
	}
	return s.tags.Rename(ctx, orgID, userID, tagUUID, trimmed)
}

// DeleteTag removes one tag and its links. Only an owner or manager may write.
func (s Service) DeleteTag(ctx context.Context, orgID, userID int64, role, tagUUID string) (domain.TagDeleted, error) {
	if !access.CanManage(role) {
		return domain.TagDeleted{}, contract.ErrForbidden
	}
	if s.tags == nil {
		return domain.TagDeleted{}, contract.ErrUnavailable
	}
	return s.tags.Delete(ctx, orgID, userID, tagUUID)
}

// TagErrorCode is the wire code for a tag failure. It mirrors the Rust
// WorkspaceStoreErrorCode values the three routes can answer with.
func TagErrorCode(err error) (status int, code string) {
	switch {
	case errors.Is(err, contract.ErrForbidden):
		return 403, "FORBIDDEN"
	case errors.Is(err, contract.ErrTagNotFound):
		return 404, "NOT_FOUND"
	case errors.Is(err, contract.ErrTagExists):
		return 409, "CONFLICT"
	case errors.Is(err, contract.ErrTagName), errors.Is(err, contract.ErrTagNameLength),
		errors.Is(err, contract.ErrTagUUID):
		return 400, "VALIDATION"
	case errors.Is(err, contract.ErrNoTenant):
		return 401, "AUTH_REQUIRED"
	default:
		return 503, "INTERNAL"
	}
}
