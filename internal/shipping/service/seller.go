package service

import (
	"context"
	"fmt"
	"time"

	"github.com/xxww0098/podhub-go/internal/shipping/contract"
	"github.com/xxww0098/podhub-go/internal/shipping/domain"
)

// SellerStore is the read/write port the seller shipping pages need.
type SellerStore interface {
	domain.Store
	SellerReadiness(ctx context.Context, orgID int64, storeUUID, sku string) (contract.SellerReadiness, error)
	EnsureInjection(ctx context.Context, orgID int64, storeUUID, presetID string, now int64) error
}

// Seller is the seller-facing shipping readiness and ensure service.
type Seller struct {
	Store              SellerStore
	Admin              Admin
	InjectWrites       bool
	OzonWritesDisabled bool
	Now                func() int64
}

func (s Seller) now() int64 {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now().UnixMilli()
}

// Readiness returns the seller-visible readiness, including whether the
// deployment currently permits writes.
func (s Seller) Readiness(ctx context.Context, orgID int64, storeUUID, sku string) (contract.SellerReadiness, error) {
	out, err := s.Store.SellerReadiness(ctx, orgID, storeUUID, sku)
	if err != nil {
		return out, err
	}
	if !s.InjectWrites || s.OzonWritesDisabled {
		out.Reasons = append(out.Reasons, contract.ReasonWritesDisabled)
		out.InjectReady = false
	}
	return out, nil
}

// Ensure reconciles the store first, then safely retries warehouse creation
// only when the current state permits it. It always returns a fresh readiness.
func (s Seller) Ensure(ctx context.Context, orgID, userID int64, storeUUID, sku string) (contract.SellerReadiness, error) {
	current, err := s.Store.SellerReadiness(ctx, orgID, storeUUID, sku)
	if err != nil {
		return current, err
	}
	if current.PresetID == "" {
		return current, contract.NotFound("SKU 未绑定发货预设")
	}
	if !s.InjectWrites {
		return current, contract.WritesDisabled("当前部署未开启物流写入")
	}
	if s.OzonWritesDisabled {
		return current, contract.WritesDisabled("Ozon 实时写入已停止")
	}
	if err := s.Store.EnsureInjection(ctx, orgID, storeUUID, current.PresetID, s.now()); err != nil {
		return current, err
	}
	actor := fmt.Sprintf("seller:%d/%d", orgID, userID)
	if _, err := s.Admin.Reconcile(ctx, storeUUID, current.PresetID, s.now()); err != nil {
		return current, err
	}
	current, err = s.Store.SellerReadiness(ctx, orgID, storeUUID, sku)
	if err != nil {
		return current, err
	}
	if current.Status != "ready" && shouldSafeContinue(current.Reasons) {
		_, _ = s.Admin.SafeContinue(ctx, storeUUID, current.PresetID, actor, s.now())
		current, err = s.Store.SellerReadiness(ctx, orgID, storeUUID, sku)
	}
	return current, err
}

func shouldSafeContinue(reasons []string) bool {
	for _, reason := range reasons {
		if reason == contract.ReasonResultUnknown || reason == contract.ReasonShopNotInjected || reason == contract.ReasonFailed {
			return true
		}
	}
	return false
}
