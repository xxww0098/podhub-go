package service

import (
	"context"
	"strconv"

	"github.com/xxww0098/podhub-go/internal/warehouse/contract"
)

func (s Service) List(ctx context.Context, actor Actor) ([]contract.Warehouse, contract.SyncStamp, error) {
	if err := s.readyStore(actor); err != nil {
		return nil, contract.SyncStamp{}, err
	}
	if s.DB == nil {
		return nil, contract.SyncStamp{}, contract.Unavailable()
	}
	return s.DB.ListWarehouses(ctx, actor.OrgID, actor.StoreID)
}

func (s Service) Get(ctx context.Context, actor Actor, warehouseID int64) (contract.Warehouse, error) {
	if err := s.readyStore(actor); err != nil {
		return contract.Warehouse{}, err
	}
	if warehouseID <= 0 {
		return contract.Warehouse{}, contract.BadRequest("warehouse_id 无效")
	}
	if s.DB == nil {
		return contract.Warehouse{}, contract.Unavailable()
	}
	return s.DB.GetWarehouse(ctx, actor.OrgID, actor.StoreID, warehouseID)
}

func (s Service) Methods(ctx context.Context, actor Actor, warehouseID int64) ([]contract.Method, error) {
	if err := s.readyStore(actor); err != nil {
		return nil, err
	}
	if s.DB == nil {
		return nil, contract.Unavailable()
	}
	return s.DB.ListMethods(ctx, actor.OrgID, actor.StoreID, warehouseID)
}

func (s Service) Method(ctx context.Context, actor Actor, methodID int64) (contract.Method, error) {
	if err := s.readyStore(actor); err != nil {
		return contract.Method{}, err
	}
	if methodID <= 0 {
		return contract.Method{}, contract.BadRequest("method_id 无效")
	}
	if s.DB == nil {
		return contract.Method{}, contract.Unavailable()
	}
	return s.DB.GetMethod(ctx, actor.OrgID, actor.StoreID, methodID)
}

// ParseID parses a positive path id.
func ParseID(raw string) (int64, error) {
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, contract.BadRequest("id 无效")
	}
	return id, nil
}
