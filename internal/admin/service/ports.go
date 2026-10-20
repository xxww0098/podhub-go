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
	ListDbs(ctx context.Context, actor contract.Actor) ([]domain.SupplierDb, error)
	CreateDb(ctx context.Context, actor contract.Actor, in domain.NormalizedDb, sourceID string, props []domain.PropSeed, nowMs int64, password string) (domain.SupplierDb, *string, error)
	UpdateDb(ctx context.Context, actor contract.Actor, sourceID string, in domain.NormalizedDb, nowMs int64, password string) (domain.SupplierDb, *string, error)
	DeleteDb(ctx context.Context, actor contract.Actor, sourceID string) error
	CreateProp(ctx context.Context, actor contract.Actor, sourceID, propID string, in domain.NormalizedProp, nowMs int64) (domain.Prop, error)
	UpdateProp(ctx context.Context, actor contract.Actor, sourceID, propID string, in domain.NormalizedProp, nowMs int64) (domain.Prop, error)
	DeleteProp(ctx context.Context, actor contract.Actor, sourceID, propID string) (int64, error)
	DeleteRow(ctx context.Context, actor contract.Actor, sourceID, productID string, nowMs int64) error
	ListAccounts(ctx context.Context, actor contract.Actor) ([]domain.Member, error)
	CreateAccount(ctx context.Context, actor contract.Actor, in domain.NormalizedAccount, publicID string, nowMs int64, password string) (domain.Member, *string, error)
	PatchAccount(ctx context.Context, actor contract.Actor, memberID string, in domain.AccountPatch, passwordHash string) (domain.Member, *string, error)
	DeleteAccount(ctx context.Context, actor contract.Actor, memberID string) error
	// AccountStaff reads account_users. Missing and disabled are found=false.
	AccountStaff(ctx context.Context, userID int64) (found, staff bool, err error)
	ListPrompts(ctx context.Context, actor contract.Actor) ([]domain.Prompt, error)
	ListWithdrawals(ctx context.Context, actor contract.Actor, status string) ([]domain.Withdrawal, error)
	PayWithdrawal(ctx context.Context, actor contract.Actor, id, reference string, nowMs int64) (domain.Withdrawal, error)
	RejectWithdrawal(ctx context.Context, actor contract.Actor, id, reason string, nowMs int64) (domain.Withdrawal, error)
	ListGrants(ctx context.Context, actor contract.Actor) ([]domain.GrantView, error)
	CreateGrant(ctx context.Context, actor contract.Actor, in domain.GrantInput) (domain.GrantView, string, error)
	RevokeGrant(ctx context.Context, actor contract.Actor, id string) (string, error)
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
	PromptDiff(ctx context.Context, actor contract.Actor, sourceID, productID string, revision *int32) (domain.PromptDiff, error)
	PublishPrompt(ctx context.Context, actor contract.Actor, sourceID, productID string, revision int32, now int64) (domain.PromptPublish, error)
	PatchPrompt(ctx context.Context, actor contract.Actor, productID string, in domain.PromptPatchInput, now int64) (domain.Prompt, error)
	SyncPrompts(ctx context.Context, actor contract.Actor, now int64) (domain.SyncReport, error)
	Referenced(ctx context.Context, actor contract.Actor, suffixes []string) (bool, error)
	Banned(ctx context.Context, actor contract.Actor) ([]string, error)
}

// ObjectRequest is one server-side call to the storage origin.
// The service never imports net/http. The HTTP adapter refuses non-loopback hosts.
type ObjectRequest struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    []byte
	Timeout time.Duration
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

// Service validates input and mints ids. It does not speak HTTP.
type Service struct {
	Store    Store
	Cat      Rows
	Origin   Origin
	Accounts AccountLoader
	Now      func() time.Time
	PublicID func() (string, error)
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
