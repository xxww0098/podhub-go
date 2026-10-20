package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// Directory reads and writes one org's stores. Implementations open a tenant
// transaction and refuse a missing org GUC before the statement.
type Directory interface {
	Load(ctx context.Context, orgID int64, storeUUID string) (domain.Store, error)
	List(ctx context.Context, orgID, userID int64) (rows []domain.Store, membership int64, hasMember bool, err error)
	SaveCompany(ctx context.Context, orgID int64, storeUUID string, patch domain.Patch) (domain.Store, error)
	Rename(ctx context.Context, orgID int64, storeUUID, name string) (domain.Store, error)
}

// SellerInfo is one read of POST /v1/seller/info. The caller supplies the
// shop credential in memory. This process does not store it.
type SellerInfo interface {
	PostSellerInfo(ctx context.Context, clientID, apiKey string) (status int, body []byte, err error)
}

// Credential opens the sealed seller key already stored for one store.
// The returned strings stay in memory for the seller call.
type Credential interface {
	Open(ctx context.Context, orgID int64, storeUUID string) (clientID, apiKey string, err error)
}
