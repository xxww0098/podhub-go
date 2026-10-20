package service

import (
	"context"
	"time"

	"github.com/xxww0098/podhub-go/internal/warehouse/contract"
)

// DB is the tenant store. Implementations open their own tenant transaction.
type DB interface {
	PrepareGrant(ctx context.Context, in contract.GrantWrite) (contract.PreparedGrant, error)
	AuditRefused(ctx context.Context, orgID, userID int64, storeID, kind string) error
	ApplyReport(ctx context.Context, in contract.ReportWrite) (contract.ReportDone, error)
	SaveSnapshot(ctx context.Context, orgID int64, storeID string, snap contract.Snapshot) error
	ListWarehouses(ctx context.Context, orgID int64, storeID string) ([]contract.Warehouse, contract.SyncStamp, error)
	GetWarehouse(ctx context.Context, orgID int64, storeID string, warehouseID int64) (contract.Warehouse, error)
	ListMethods(ctx context.Context, orgID int64, storeID string, warehouseID int64) ([]contract.Method, error)
	GetMethod(ctx context.Context, orgID int64, storeID string, methodID int64) (contract.Method, error)
	ListRFBS(ctx context.Context, orgID int64, storeID string) ([]contract.Warehouse, error)
	FindOperation(ctx context.Context, orgID int64, storeID, operationID string) (contract.Operation, error)
}

// Opener decrypts one store credential. It does not dial Ozon.
type Opener interface {
	Open(ctx context.Context, orgID, userID int64, role, storeID string, now time.Time) (clientID, apiKey string, err error)
}

// Poster is one loopback Seller read. Write calls do not use it.
type Poster interface {
	Post(ctx context.Context, path string, body []byte, clientID, apiKey string) (status int, resp []byte, err error)
}

// Limiter spends one rate-limit slot. A nil limiter fails closed.
type Limiter interface {
	Reserve(ctx context.Context, scope string) error
}

// ErrorCatalog records one Seller failure in the Ozon error catalog.
// A nil catalog skips the call. taskKey identifies the sighting.
// code is a Seller code, or empty when only the HTTP status is known.
// The call must not carry a request body, a key, or a message.
type ErrorCatalog interface {
	RecordOzon(ctx context.Context, orgID int64, taskKey string, status int, code string)
}

// Service orchestrates reads and browser-direct writes.
type Service struct {
	DB     DB
	Open   Opener
	Post   Poster
	Limit  Limiter
	Errors ErrorCatalog
	Now    func() time.Time
}

func (s Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now().UTC()
}

// Actor is the session tenant. OrgID is never taken from the request body.
type Actor struct {
	OrgID   int64
	UserID  int64
	Role    string
	StoreID string
}

// GrantInput is one browser key request. WritesDisabled is the bool the
// process already captured. This service does not read the environment.
type GrantInput struct {
	contract.GrantWrite
	Role           string
	WritesDisabled bool
}

// GrantResult is the plaintext response. Callers must not log it.
type GrantResult struct {
	IntentID    string
	State       string
	ClientID    string
	APIKey      string
	ExpiresAtMS int64
	TTLMS       int64
}

// OpStatus is the verified operation-status read.
type OpStatus struct {
	OperationID string
	Status      string
	WarehouseID *int64
}
