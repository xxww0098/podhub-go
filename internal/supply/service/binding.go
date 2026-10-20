package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/supply/contract"
)

// Service is the supply use-case layer.
// Portal methods delegate when the repository implements Portal.
// GetBinding stays on Port for the column projection the old tests read.
type Service struct {
	port   Port
	portal Portal
}

// New binds a repository. A Portal implementation is picked up when present.
func New(port Port) Service {
	s := Service{port: port}
	if p, ok := port.(Portal); ok {
		s.portal = p
	}
	return s
}

func (s Service) GetBinding(ctx context.Context, orgID int64, listingRowID string) (contract.Binding, error) {
	if orgID <= 0 {
		return contract.Binding{}, contract.ErrNoTenant
	}
	return s.port.GetBinding(ctx, orgID, listingRowID)
}
