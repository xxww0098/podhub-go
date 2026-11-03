// Package service is the supplier-admin use cases.
package service

import (
	"context"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

// Store is the database port. HTTP does not import the repo.
type Store interface {
	ListFactories(ctx context.Context, actor contract.Actor) ([]domain.Factory, error)
	CreateFactory(ctx context.Context, actor contract.Actor, in domain.FactoryInput, factoryID string, nowMs int64, password, passwordHash string) (domain.Factory, *string, error)
	UpdateFactory(ctx context.Context, actor contract.Actor, factoryID string, in domain.FactoryInput, nowMs int64) (domain.Factory, error)
	DeleteFactory(ctx context.Context, actor contract.Actor, factoryID string) error
	ListDbs(ctx context.Context, actor contract.Actor) ([]domain.SupplierDb, error)
	CreateDb(ctx context.Context, actor contract.Actor, in domain.NormalizedDb, sourceID string, props []domain.PropSeed, nowMs int64) (domain.SupplierDb, error)
	UpdateDb(ctx context.Context, actor contract.Actor, sourceID string, in domain.NormalizedDb, nowMs int64) (domain.SupplierDb, error)
	DeleteDb(ctx context.Context, actor contract.Actor, sourceID string) error
	CreateProp(ctx context.Context, actor contract.Actor, sourceID, propID string, in domain.NormalizedProp, nowMs int64) (domain.Prop, error)
	UpdateProp(ctx context.Context, actor contract.Actor, sourceID, propID string, in domain.NormalizedProp, nowMs int64) (domain.Prop, error)
	DeleteProp(ctx context.Context, actor contract.Actor, sourceID, propID string) (int64, error)
	DeleteRow(ctx context.Context, actor contract.Actor, sourceID, productID string, nowMs int64) error
	ListAccounts(ctx context.Context, actor contract.Actor) ([]domain.Member, error)
	CreateAccount(ctx context.Context, actor contract.Actor, in domain.NormalizedAccount, nowMs int64, password, passwordHash string) (domain.Member, *string, error)
	PatchAccount(ctx context.Context, actor contract.Actor, memberID string, in domain.AccountPatch, passwordHash string, nowMs int64) (domain.Member, *string, error)
	DeleteAccount(ctx context.Context, actor contract.Actor, memberID string, nowMs int64) error
	// AccountStaff reads account_users. Missing and disabled are found=false.
	AccountStaff(ctx context.Context, userID int64) (found, staff bool, err error)
	ListWithdrawals(ctx context.Context, actor contract.Actor, status string) ([]domain.Withdrawal, error)
	PayWithdrawal(ctx context.Context, actor contract.Actor, id, reference string, nowMs int64) (domain.Withdrawal, error)
	RejectWithdrawal(ctx context.Context, actor contract.Actor, id, reason string, nowMs int64) (domain.Withdrawal, error)
	ListGrants(ctx context.Context, actor contract.Actor) ([]domain.GrantView, error)
	CreateGrant(ctx context.Context, actor contract.Actor, in domain.GrantInput) (domain.GrantView, string, error)
	RevokeGrant(ctx context.Context, actor contract.Actor, id string) (string, error)
	// SourceRoleStore is the two staff-side authorization tables. Fulfiller is
	// the supplier-portal role; catalog manager is the /api/catalog role.
	ListFulfillers(ctx context.Context, actor contract.Actor, sourceID string) ([]domain.Fulfiller, error)
	GrantFulfiller(ctx context.Context, actor contract.Actor, sourceID, accountUUID string, nowMs int64) (domain.Fulfiller, error)
	RevokeFulfiller(ctx context.Context, actor contract.Actor, sourceID, fulfillerID string, nowMs int64) error
	ListCatalogManagers(ctx context.Context, actor contract.Actor, sourceID string) ([]domain.CatalogManager, error)
	GrantCatalogManager(ctx context.Context, actor contract.Actor, sourceID, accountUUID string, nowMs int64) (domain.CatalogManager, error)
	RevokeCatalogManager(ctx context.Context, actor contract.Actor, sourceID, managerID string, nowMs int64) error
}

// Rows is the supplier-db success path. The repo implements it.
// HTTP fakes that only implement Store leave this nil.
type Rows interface {
	Detail(ctx context.Context, actor contract.Actor, sourceID string, now int64) (domain.DbDetail, error)
	CreateRow(ctx context.Context, actor contract.Actor, sourceID string, in domain.RowInput, productID, skuID, code string, now int64) (domain.RowData, error)
	UpdateRow(ctx context.Context, actor contract.Actor, sourceID, productID string, in domain.RowInput, now int64) (domain.RowData, error)
	AdjustPrice(ctx context.Context, actor contract.Actor, sourceID, productID string, cents int64, note string, now int64) (domain.RowData, error)
	SetPublished(ctx context.Context, actor contract.Actor, sourceID, productID string, on bool, now int64) (domain.RowData, error)
	LoadOzon(ctx context.Context, actor contract.Actor, sourceID, productID string, now int64) (domain.OzonConfig, error)
	SaveOzon(ctx context.Context, actor contract.Actor, sourceID, productID string, in domain.OzonPut, now int64) (domain.OzonConfig, error)
	Referenced(ctx context.Context, actor contract.Actor, suffixes []string) (bool, error)
	Banned(ctx context.Context, actor contract.Actor) ([]string, error)
}

// ObjectRequest is one server-side call to the storage origin.
// The service never imports net/http. The HTTP adapter checks the configured origin.
type ObjectRequest struct {
	Account  sign.Account
	Method   string
	URL      string
	Headers  map[string]string
	Body     []byte
	Timeout  time.Duration
	MaxBytes int64
}

// ObjectResponse is the origin status, lower-cased headers, and body.
type ObjectResponse struct {
	Status  int
	Headers map[string]string
	Body    []byte
}

// Origin performs a presigned storage call. A nil origin fails closed.
type Origin interface {
	Do(ctx context.Context, req ObjectRequest) (ObjectResponse, error)
}

// AccountLoader returns the supplier bucket. ok false means it is not configured.
type AccountLoader func(ctx context.Context) (sign.Account, bool, error)

type CatalogSourceAccess interface {
	CanMaintain(context.Context, int64, string) (bool, error)
}

// Service validates input and mints ids. It does not speak HTTP.
type Service struct {
	Store         Store
	Cat           Rows
	Origin        Origin
	Accounts      AccountLoader
	CatalogAccess CatalogSourceAccess
	Now           func() time.Time
	PublicID      func() (string, error)
}

func New(store Store) Service {
	s := Service{Store: store, Now: time.Now, PublicID: domain.NewPublicID}
	if c, ok := store.(Rows); ok {
		s.Cat = c
	}
	return s
}

// NowMillis is the clock the HTTP layer stamps onto withdrawal decisions.
func (s Service) NowMillis() int64 { return s.nowMs() }

func (s Service) nowMs() int64 {
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	return now().UnixMilli()
}

func (s Service) publicID() (string, error) {
	if s.PublicID != nil {
		return s.PublicID()
	}
	return domain.NewPublicID()
}

func fillDisabled(err error, message string) error {
	f, ok := contract.AsFail(err)
	if ok && f.Kind == contract.KindWritesDisabled && f.Message == "" {
		f.Message = message
	}
	return err
}

func unavailable(err error) error {
	if err == nil {
		return &contract.Fail{Kind: contract.KindInternal, Message: "服务暂不可用"}
	}
	return err
}
