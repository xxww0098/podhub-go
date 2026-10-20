package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/supply/contract"
	"github.com/xxww0098/podhub-go/internal/supply/domain"
)

// Portal is the seller and public catalog store behind the ten routes.
type Portal interface {
	PublicCatalog(ctx context.Context) (contract.PublicCatalogData, error)
	SellerCatalog(ctx context.Context, orgID int64) (contract.SellerCatalogData, error)
	SellerProduct(ctx context.Context, orgID int64, productID string) (contract.SellerProduct, error)
	SellerSKU(ctx context.Context, orgID int64, skuID string) (contract.SellerSKU, error)
	BindingView(ctx context.Context, orgID int64, listingRowID string) (contract.BindingData, error)
	PutBinding(ctx context.Context, orgID, userID int64, listingRowID string, files []domain.ProductionFile, sku string, quantity, nowMs int64) (contract.BindingData, error)
	DeleteBinding(ctx context.Context, orgID int64, listingRowID string) error
	CreateQuote(ctx context.Context, orgID, userID int64, listingRowID string, quantity int64, key string, nowMs int64) (contract.QuoteData, error)
	ConfirmOrder(ctx context.Context, orgID, userID int64, quoteID, key string, nowMs int64) (contract.OrderData, error)
	GetOrder(ctx context.Context, orgID int64, orderID string) (contract.OrderData, error)
}

func (s Service) need() error {
	if s.portal == nil {
		return contract.ErrNotPorted
	}
	return nil
}

func (s Service) PublicCatalog(ctx context.Context) (contract.PublicCatalogData, error) {
	if err := s.need(); err != nil {
		return contract.PublicCatalogData{}, err
	}
	return s.portal.PublicCatalog(ctx)
}

func (s Service) SellerCatalog(ctx context.Context, orgID int64) (contract.SellerCatalogData, error) {
	if err := s.need(); err != nil {
		return contract.SellerCatalogData{}, err
	}
	return s.portal.SellerCatalog(ctx, orgID)
}

func (s Service) SellerProduct(ctx context.Context, orgID int64, productID string) (contract.SellerProduct, error) {
	if err := s.need(); err != nil {
		return contract.SellerProduct{}, err
	}
	return s.portal.SellerProduct(ctx, orgID, productID)
}

func (s Service) SellerSKU(ctx context.Context, orgID int64, skuID string) (contract.SellerSKU, error) {
	if err := s.need(); err != nil {
		return contract.SellerSKU{}, err
	}
	return s.portal.SellerSKU(ctx, orgID, skuID)
}

func (s Service) BindingView(ctx context.Context, orgID int64, listingRowID string) (contract.BindingData, error) {
	if err := s.need(); err != nil {
		return contract.BindingData{}, err
	}
	return s.portal.BindingView(ctx, orgID, listingRowID)
}

func (s Service) PutBinding(ctx context.Context, orgID, userID int64, listingRowID string, files []domain.ProductionFile, sku string, quantity, nowMs int64) (contract.BindingData, error) {
	if err := s.need(); err != nil {
		return contract.BindingData{}, err
	}
	return s.portal.PutBinding(ctx, orgID, userID, listingRowID, files, sku, quantity, nowMs)
}

func (s Service) DeleteBinding(ctx context.Context, orgID int64, listingRowID string) error {
	if err := s.need(); err != nil {
		return err
	}
	return s.portal.DeleteBinding(ctx, orgID, listingRowID)
}

func (s Service) CreateQuote(ctx context.Context, orgID, userID int64, listingRowID string, quantity int64, key string, nowMs int64) (contract.QuoteData, error) {
	if err := s.need(); err != nil {
		return contract.QuoteData{}, err
	}
	return s.portal.CreateQuote(ctx, orgID, userID, listingRowID, quantity, key, nowMs)
}

func (s Service) ConfirmOrder(ctx context.Context, orgID, userID int64, quoteID, key string, nowMs int64) (contract.OrderData, error) {
	if err := s.need(); err != nil {
		return contract.OrderData{}, err
	}
	return s.portal.ConfirmOrder(ctx, orgID, userID, quoteID, key, nowMs)
}

func (s Service) GetOrder(ctx context.Context, orgID int64, orderID string) (contract.OrderData, error) {
	if err := s.need(); err != nil {
		return contract.OrderData{}, err
	}
	return s.portal.GetOrder(ctx, orgID, orderID)
}
