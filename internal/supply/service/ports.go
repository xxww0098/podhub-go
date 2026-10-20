package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/supply/contract"
)

// Port loads one listing binding for the session org.
type Port interface {
	GetBinding(ctx context.Context, orgID int64, listingRowID string) (contract.Binding, error)
}
