package service

import (
	"context"
	"time"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
	"github.com/xxww0098/podhub-go/internal/supplier/domain"
)

// Portal is the supplier HTTP store. A repository that implements Portal is
// wired through New.
type Portal interface {
	Me(ctx context.Context, userID int64) (contract.MeData, error)
	ListDispatches(ctx context.Context, userID int64, sourceID, view, search, status, reason string, cursor domain.Cursor, now time.Time) (contract.DispatchListData, error)
	Dashboard(ctx context.Context, userID int64, sourceID string, now time.Time) (contract.DashboardData, error)
	GetDispatch(ctx context.Context, userID int64, dispatchID string) (contract.DispatchDetail, error)
	Accept(ctx context.Context, userID int64, dispatchID string) (contract.ActionData, error)
	Reject(ctx context.Context, userID int64, dispatchID, reason string) (contract.ActionData, error)
	Ship(ctx context.Context, userID int64, dispatchID, tracking, note string, nowMs int64) (contract.ActionData, error)
	DownloadAsset(ctx context.Context, userID int64, dispatchID, assetID string, wantJSON bool, nowMs int64) (contract.DownloadGrant, error)
	Catalog(ctx context.Context, userID, nowMs int64) (contract.CatalogData, error)
	CatalogImage(ctx context.Context, sourceID, file string, edge uint32) (contract.ImageBody, error)
}

func (s Service) Me(ctx context.Context, userID int64) (contract.MeData, error) {
	if s.portal == nil {
		return contract.MeData{}, contract.ErrNotPorted
	}
	return s.portal.Me(ctx, userID)
}

func (s Service) ListDispatches(ctx context.Context, userID int64, sourceID, view, search, status, reason string, cursor domain.Cursor, now time.Time) (contract.DispatchListData, error) {
	if s.portal == nil {
		return contract.DispatchListData{}, contract.ErrNotPorted
	}
	return s.portal.ListDispatches(ctx, userID, sourceID, view, search, status, reason, cursor, now)
}

func (s Service) Dashboard(ctx context.Context, userID int64, sourceID string, now time.Time) (contract.DashboardData, error) {
	if s.portal == nil {
		return contract.DashboardData{}, contract.ErrNotPorted
	}
	return s.portal.Dashboard(ctx, userID, sourceID, now)
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

func (s Service) DownloadAsset(ctx context.Context, userID int64, dispatchID, assetID string, wantJSON bool, nowMs int64) (contract.DownloadGrant, error) {
	if s.portal == nil {
		return contract.DownloadGrant{}, contract.ErrNotPorted
	}
	return s.portal.DownloadAsset(ctx, userID, dispatchID, assetID, wantJSON, nowMs)
}

func (s Service) Catalog(ctx context.Context, userID, nowMs int64) (contract.CatalogData, error) {
	if s.portal == nil {
		return contract.CatalogData{}, contract.ErrNotPorted
	}
	return s.portal.Catalog(ctx, userID, nowMs)
}

func (s Service) CatalogImage(ctx context.Context, sourceID, file string, edge uint32) (contract.ImageBody, error) {
	if s.portal == nil {
		return contract.ImageBody{}, contract.ErrNotPorted
	}
	return s.portal.CatalogImage(ctx, sourceID, file, edge)
}
