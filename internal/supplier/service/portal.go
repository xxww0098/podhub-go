package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
	"github.com/xxww0098/podhub-go/internal/supplier/domain"
)

// Portal is the supplier HTTP store. The wallet Port stays for the CHECK-only
// helpers. A repository that implements Portal is wired through New.
type Portal interface {
	Me(ctx context.Context, userID int64) (contract.MeData, error)
	ListDispatches(ctx context.Context, userID int64, state string, cursor domain.Cursor) (contract.DispatchListData, error)
	GetDispatch(ctx context.Context, userID int64, dispatchID string) (contract.DispatchDetail, error)
	Accept(ctx context.Context, userID int64, dispatchID string) (contract.ActionData, error)
	Reject(ctx context.Context, userID int64, dispatchID, reason string) (contract.ActionData, error)
	Ship(ctx context.Context, userID int64, dispatchID, tracking, note string, nowMs int64) (contract.ActionData, error)
	Wallets(ctx context.Context, userID int64) (contract.WalletListData, error)
	Withdrawals(ctx context.Context, userID int64) (contract.WithdrawalListData, error)
	CreateWithdrawal(ctx context.Context, userID int64, in domain.WithdrawalInput, nowMs int64) (contract.WithdrawalListData, error)
	DownloadAsset(ctx context.Context, userID int64, dispatchID, assetID string, wantJSON bool, nowMs int64) (contract.AssetBytes, error)
	Catalog(ctx context.Context, nowMs int64) (contract.CatalogData, error)
	CatalogImage(ctx context.Context, sourceID, file string, edge uint32) (contract.ImageBody, error)
}

func (s Service) Me(ctx context.Context, userID int64) (contract.MeData, error) {
	if s.portal == nil {
		return contract.MeData{}, contract.ErrNotPorted
	}
	return s.portal.Me(ctx, userID)
}

func (s Service) ListDispatches(ctx context.Context, userID int64, state string, cursor domain.Cursor) (contract.DispatchListData, error) {
	if s.portal == nil {
		return contract.DispatchListData{}, contract.ErrNotPorted
	}
	return s.portal.ListDispatches(ctx, userID, state, cursor)
}

func (s Service) GetDispatch(ctx context.Context, userID int64, dispatchID string) (contract.DispatchDetail, error) {
	if s.portal == nil {
		return contract.DispatchDetail{}, contract.ErrNotPorted
	}
	return s.portal.GetDispatch(ctx, userID, dispatchID)
}

func (s Service) Accept(ctx context.Context, userID int64, dispatchID string) (contract.ActionData, error) {
	if s.portal == nil {
		return contract.ActionData{}, contract.ErrNotPorted
	}
	return s.portal.Accept(ctx, userID, dispatchID)
}

func (s Service) Reject(ctx context.Context, userID int64, dispatchID, reason string) (contract.ActionData, error) {
	if s.portal == nil {
		return contract.ActionData{}, contract.ErrNotPorted
	}
	return s.portal.Reject(ctx, userID, dispatchID, reason)
}

func (s Service) Ship(ctx context.Context, userID int64, dispatchID, tracking, note string, nowMs int64) (contract.ActionData, error) {
	if s.portal == nil {
		return contract.ActionData{}, contract.ErrNotPorted
	}
	return s.portal.Ship(ctx, userID, dispatchID, tracking, note, nowMs)
}

func (s Service) Wallets(ctx context.Context, userID int64) (contract.WalletListData, error) {
	if s.portal == nil {
		return contract.WalletListData{}, contract.ErrNotPorted
	}
	return s.portal.Wallets(ctx, userID)
}

func (s Service) Withdrawals(ctx context.Context, userID int64) (contract.WithdrawalListData, error) {
	if s.portal == nil {
		return contract.WithdrawalListData{}, contract.ErrNotPorted
	}
	return s.portal.Withdrawals(ctx, userID)
}

func (s Service) CreateWithdrawal(ctx context.Context, userID int64, in domain.WithdrawalInput, nowMs int64) (contract.WithdrawalListData, error) {
	if s.portal == nil {
		return contract.WithdrawalListData{}, contract.ErrNotPorted
	}
	return s.portal.CreateWithdrawal(ctx, userID, in, nowMs)
}

func (s Service) DownloadAsset(ctx context.Context, userID int64, dispatchID, assetID string, wantJSON bool, nowMs int64) (contract.AssetBytes, error) {
	if s.portal == nil {
		return contract.AssetBytes{}, contract.ErrNotPorted
	}
	return s.portal.DownloadAsset(ctx, userID, dispatchID, assetID, wantJSON, nowMs)
}

func (s Service) Catalog(ctx context.Context, nowMs int64) (contract.CatalogData, error) {
	if s.portal == nil {
		return contract.CatalogData{}, contract.ErrNotPorted
	}
	return s.portal.Catalog(ctx, nowMs)
}

func (s Service) CatalogImage(ctx context.Context, sourceID, file string, edge uint32) (contract.ImageBody, error) {
	if s.portal == nil {
		return contract.ImageBody{}, contract.ErrNotPorted
	}
	return s.portal.CatalogImage(ctx, sourceID, file, edge)
}
