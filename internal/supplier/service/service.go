package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
)

// Service is the supplier portal. Portal methods delegate to the same value
// when it implements Portal.
//
// There is no wallet or withdrawal surface: suppliers have no funds access
// (docs/architecture/account-permission-model.md §9). All three /api/supplier
// wallet routes were unmounted, so the read and create helpers are gone too.
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

// Download does not fetch an object.
func (s Service) Download(context.Context) error { return contract.ErrNotPorted }
