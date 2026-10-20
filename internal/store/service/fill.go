package service

import (
	"context"
	"log/slog"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// Service fills store names from seller info and groups stores by legal name.
type Service struct {
	dir        Directory
	info       SellerInfo
	cred       Credential
	tags       TagDirectory
	roster     RosterDirectory
	credential CredentialDirectory
	products   ProductDirectory
	snapshots  SnapshotDirectory
	thumbs     ThumbnailSource
	// syncDisabled is OZON_PRODUCT_SYNC_DISABLED, captured at assembly. It
	// stops scheduling and verify from leaving; reads still render.
	syncDisabled bool
}

// New binds the directory and the seller-info reader.
func New(dir Directory, info SellerInfo) Service {
	return Service{dir: dir, info: info}
}

// WithCredential sets the opener used by Refresh.
func (s Service) WithCredential(cred Credential) Service {
	s.cred = cred
	return s
}

// Result is the store after a credential save, verify, or refresh.
// UpstreamFailed means the seller call did not replace the display name.
// CurrencyWarning is set when the company currency and the store pricing
// currency are both present and differ.
type Result struct {
	Filled           bool
	UpstreamFailed   bool
	Name             string
	Source           string
	Store            domain.Store
	CurrencyMismatch bool
	CurrencyWarning  string
}

// OnCredentialSaved runs after a credential write has already been accepted.
// A seller-info failure is logged and does not come back as an error.
func (s Service) OnCredentialSaved(ctx context.Context, orgID int64, storeUUID, clientID, apiKey string) (Result, error) {
	return s.apply(ctx, orgID, storeUUID, clientID, apiKey)
}

// OnCredentialVerified is the same fill as a save. A failed check does not
// roll back a credential that was already stored by the caller.
func (s Service) OnCredentialVerified(ctx context.Context, orgID int64, storeUUID, clientID, apiKey string) (Result, error) {
	return s.apply(ctx, orgID, storeUUID, clientID, apiKey)
}

// Refresh reads seller info again for a store that already has a sealed key.
// The Ozon call is a read. A missing key does not invent one.
// The warning is empty when the company currency matches the pricing currency.
func (s Service) Refresh(ctx context.Context, orgID, userID int64, role, storeUUID string) (domain.Store, string, error) {
	if !access.CanManage(role) {
		return domain.Store{}, "", contract.ErrForbidden
	}
	_ = userID
	if s.dir == nil || s.cred == nil {
		return domain.Store{}, "", contract.ErrUnavailable
	}
	clientID, apiKey, err := s.cred.Open(ctx, orgID, storeUUID)
	if err != nil {
		return domain.Store{}, "", err
	}
	result, err := s.apply(ctx, orgID, storeUUID, clientID, apiKey)
	if err != nil {
		return domain.Store{}, "", err
	}
	return result.Store, result.CurrencyWarning, nil
}

func (s Service) apply(ctx context.Context, orgID int64, storeUUID, clientID, apiKey string) (Result, error) {
	if s.dir == nil {
		return Result{}, contract.ErrUnavailable
	}
	row, err := s.dir.Load(ctx, orgID, storeUUID)
	if err != nil {
		return Result{}, err
	}
	current := resultFrom(row)
	if s.info == nil || clientID == "" || apiKey == "" {
		skip(orgID, storeUUID, "upstream")
		current.UpstreamFailed = true
		return current, nil
	}
	status, body, callErr := s.info.PostSellerInfo(ctx, clientID, apiKey)
	parsed := false
	var company domain.Company
	if callErr == nil && status >= 200 && status < 300 {
		company, parsed = domain.ParseSellerInfo(body)
	}
	for i := range body {
		body[i] = 0
	}
	state, reason := domain.ClassifySellerCall(status, callErr, parsed)
	if state != domain.KeyValid {
		skip(orgID, storeUUID, reason)
	}
	patch := domain.Patch{KeyStatus: &state, KeyReason: &reason}
	filled := false
	if state == domain.KeyValid && parsed && reason == "" {
		next, ok := domain.FillName(row.Name, row.Source, company.ShortName)
		if short := domain.KeepShort(company.ShortName); short != "" {
			patch.Short = &short
		}
		if legal := domain.KeepLegal(company.LegalName); legal != "" {
			patch.Legal = &legal
		}
		if currency := domain.KeepCurrency(company.Currency); currency != "" {
			patch.Currency = &currency
		}
		if country := domain.KeepCountry(company.Country); country != "" {
			patch.Country = &country
		}
		if company.Premium != nil {
			patch.Premium = company.Premium
		}
		if subType := domain.KeepSubType(company.SubType); subType != "" {
			patch.SubType = &subType
		}
		if ok {
			patch.Name = &next
			filled = true
		}
		patch.TouchSynced = true
	}
	saved, err := s.dir.SaveCompany(ctx, orgID, storeUUID, patch)
	if err != nil {
		return Result{}, err
	}
	out := resultFrom(saved)
	out.Filled = filled
	out.UpstreamFailed = state != domain.KeyValid
	currency := saved.Currency
	if patch.Currency != nil {
		currency = *patch.Currency
	}
	out.CurrencyWarning = domain.CurrencyWarning(currency, row.PricingCurrency)
	out.CurrencyMismatch = out.CurrencyWarning != ""
	return out, nil
}

func resultFrom(row domain.Store) Result {
	return Result{Name: row.Name, Source: row.Source, Store: row}
}

func skip(orgID int64, storeUUID, reason string) {
	slog.Warn("seller info fill skipped", "org_id", orgID, "store_id", storeUUID, "reason", reason)
}

// Groups returns company.legal_name buckets visible to the caller.
// Stores outside the caller's org are not in the directory result.
func (s Service) Groups(ctx context.Context, orgID, userID int64, role string) ([]domain.Group, error) {
	if s.dir == nil {
		return nil, contract.ErrUnavailable
	}
	rows, membership, hasMember, err := s.dir.List(ctx, orgID, userID)
	if err != nil {
		return nil, err
	}
	memberID := int64(0)
	if hasMember {
		memberID = membership
	}
	visible := make([]domain.Store, 0, len(rows))
	for _, row := range rows {
		if access.StoreVisible(role, row.Assignee, memberID) {
			visible = append(visible, row)
		}
	}
	groups := domain.GroupByLegalName(visible)
	if groups == nil {
		groups = []domain.Group{}
	}
	return groups, nil
}

// Rename sets the display name and name_source manual.
// The same trimmed name is not a rename, and the source stays as it was.
func (s Service) Rename(ctx context.Context, orgID, userID int64, role, storeUUID, name string) (domain.Store, error) {
	if !access.CanManage(role) {
		return domain.Store{}, contract.ErrForbidden
	}
	if s.dir == nil {
		return domain.Store{}, contract.ErrUnavailable
	}
	trimmed, err := domain.ValidName(name)
	if err != nil {
		if domain.NameTooLong(err) {
			return domain.Store{}, contract.ErrNameLength
		}
		return domain.Store{}, contract.ErrName
	}
	_ = userID
	return s.dir.Rename(ctx, orgID, storeUUID, trimmed)
}
