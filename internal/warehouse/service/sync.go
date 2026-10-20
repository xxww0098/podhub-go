package service

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"

	"github.com/xxww0098/podhub-go/internal/warehouse/contract"
	"github.com/xxww0098/podhub-go/internal/warehouse/domain"
)

// Sync reads /v2/warehouse/list and, for realFBS rows, delivery methods.
// It never requests the retired v1 warehouse list.
func (s Service) Sync(ctx context.Context, actor Actor) (contract.Snapshot, error) {
	if err := s.readyStore(actor); err != nil {
		return contract.Snapshot{}, err
	}
	if err := s.reserve(ctx, "warehouse-sync:"+actor.StoreID); err != nil {
		return contract.Snapshot{}, err
	}
	clientID, apiKey, err := s.open(ctx, actor)
	if err != nil {
		return contract.Snapshot{}, err
	}
	houses, err := s.fetchWarehouses(ctx, actor.OrgID, clientID, apiKey)
	if err != nil {
		return contract.Snapshot{}, err
	}
	methods, err := s.fetchMethods(ctx, actor.OrgID, clientID, apiKey, rfbsIDs(houses))
	if err != nil {
		return contract.Snapshot{}, err
	}
	at := s.now()
	if s.DB == nil {
		return contract.Snapshot{}, contract.Unavailable()
	}
	snap := contract.Snapshot{Warehouses: houses, Methods: methods, At: at, WriteWarehouses: true, WriteMethods: true}
	if err := s.DB.SaveSnapshot(ctx, actor.OrgID, actor.StoreID, snap); err != nil {
		return contract.Snapshot{}, err
	}
	return snap, nil
}

// SyncMethods refreshes delivery methods for warehouses already cached as realFBS.
func (s Service) SyncMethods(ctx context.Context, actor Actor) ([]contract.Method, error) {
	if err := s.readyStore(actor); err != nil {
		return nil, err
	}
	if s.DB == nil {
		return nil, contract.Unavailable()
	}
	if err := s.reserve(ctx, "warehouse-method-sync:"+actor.StoreID); err != nil {
		return nil, err
	}
	houses, err := s.DB.ListRFBS(ctx, actor.OrgID, actor.StoreID)
	if err != nil {
		return nil, err
	}
	if len(houses) == 0 {
		return nil, contract.NotSynced()
	}
	clientID, apiKey, err := s.open(ctx, actor)
	if err != nil {
		return nil, err
	}
	methods, err := s.fetchMethods(ctx, actor.OrgID, clientID, apiKey, rfbsIDs(houses))
	if err != nil {
		return nil, err
	}
	snap := contract.Snapshot{Methods: methods, At: s.now(), WriteMethods: true}
	if err := s.DB.SaveSnapshot(ctx, actor.OrgID, actor.StoreID, snap); err != nil {
		return nil, err
	}
	return methods, nil
}

// OperationStatus reads /v1/warehouse/operation/status for an operation this org reported.
func (s Service) OperationStatus(ctx context.Context, actor Actor, operationID string) (OpStatus, error) {
	if err := s.readyStore(actor); err != nil {
		return OpStatus{}, err
	}
	operationID = trimOp(operationID)
	if operationID == "" || len(operationID) > 128 {
		return OpStatus{}, contract.BadRequest("operationId 无效")
	}
	if s.DB == nil {
		return OpStatus{}, contract.Unavailable()
	}
	if err := s.reserve(ctx, "warehouse-op:"+actor.StoreID); err != nil {
		return OpStatus{}, err
	}
	if _, err := s.DB.FindOperation(ctx, actor.OrgID, actor.StoreID, operationID); err != nil {
		return OpStatus{}, err
	}
	clientID, apiKey, err := s.open(ctx, actor)
	if err != nil {
		return OpStatus{}, err
	}
	body, _ := json.Marshal(map[string]string{"operation_id": operationID})
	status, resp, err := s.post(ctx, actor.OrgID, domain.PathOperation, body, clientID, apiKey)
	if err != nil {
		return OpStatus{}, err
	}
	parsed, err := domain.ParseOperation(resp)
	if err != nil || parsed.Obsolete || status < 200 || status >= 300 {
		if parsed.Obsolete {
			return OpStatus{}, contract.Obsolete()
		}
		return OpStatus{}, contract.Ozon()
	}
	return OpStatus{OperationID: operationID, Status: parsed.Status, WarehouseID: parsed.WarehouseID}, nil
}

func (s Service) fetchWarehouses(ctx context.Context, orgID int64, clientID, apiKey string) ([]contract.Warehouse, error) {
	var all []contract.Warehouse
	cursor := ""
	for page := 0; page < domain.PageLimit; page++ {
		req := map[string]any{"limit": domain.WarehousePageLimit, "warehouse_ids": []any{}}
		if cursor != "" {
			req["cursor"] = cursor
		}
		body, _ := json.Marshal(req)
		status, resp, err := s.post(ctx, orgID, domain.PathWarehouseList, body, clientID, apiKey)
		if err != nil {
			return nil, err
		}
		parsed, err := domain.ParseWarehouses(resp)
		if err != nil {
			return nil, contract.Ozon()
		}
		if parsed.Obsolete {
			return nil, contract.Obsolete()
		}
		if status < 200 || status >= 300 {
			return nil, contract.Ozon()
		}
		all = append(all, parsed.Rows...)
		next := parsed.Cursor
		if !parsed.HasNext || next == "" || next == cursor {
			return dedupeHouses(all), nil
		}
		cursor = next
	}
	return nil, contract.Ozon()
}

func (s Service) fetchMethods(ctx context.Context, orgID int64, clientID, apiKey string, warehouseIDs []int64) ([]contract.Method, error) {
	var all []contract.Method
	for _, id := range warehouseIDs {
		offset := 0
		for page := 0; page < domain.PageLimit; page++ {
			req := map[string]any{
				"limit":  domain.MethodPageLimit,
				"offset": offset,
				"filter": map[string]any{"warehouse_id": id},
			}
			body, _ := json.Marshal(req)
			status, resp, err := s.post(ctx, orgID, domain.PathMethodList, body, clientID, apiKey)
			if err != nil {
				return nil, err
			}
			parsed, err := domain.ParseMethods(resp)
			if err != nil {
				return nil, contract.Ozon()
			}
			if parsed.Obsolete {
				return nil, contract.Obsolete()
			}
			if status < 200 || status >= 300 {
				return nil, contract.Ozon()
			}
			all = append(all, parsed.Rows...)
			if !parsed.HasNext || len(parsed.Rows) == 0 {
				break
			}
			offset += len(parsed.Rows)
			if page == domain.PageLimit-1 {
				return nil, contract.Ozon()
			}
		}
	}
	return dedupeMethods(all), nil
}

func (s Service) post(ctx context.Context, orgID int64, path string, body []byte, clientID, apiKey string) (int, []byte, error) {
	if s.Post == nil {
		return 0, nil, contract.Unavailable()
	}
	status, resp, err := s.Post.Post(ctx, path, body, clientID, apiKey)
	if err != nil {
		if errors.Is(err, contract.ErrRateLimited) {
			return 0, nil, contract.RateLimited()
		}
		return 0, nil, contract.Ozon()
	}
	if status < 200 || status >= 300 || domain.Obsolete(resp) {
		s.record(ctx, orgID, path, status, domain.OzonCode(resp))
	}
	return status, resp, nil
}

func (s Service) readyStore(actor Actor) error {
	if actor.OrgID <= 0 || actor.UserID <= 0 {
		return contract.Forbidden()
	}
	if _, err := uuid.Parse(actor.StoreID); err != nil {
		return contract.BadRequest("storeId 无效")
	}
	return nil
}

func rfbsIDs(rows []contract.Warehouse) []int64 {
	var ids []int64
	for _, row := range rows {
		if row.IsRFBS {
			ids = append(ids, row.WarehouseID)
		}
	}
	return ids
}

func dedupeHouses(rows []contract.Warehouse) []contract.Warehouse {
	seen := map[int64]int{}
	var out []contract.Warehouse
	for _, row := range rows {
		if i, ok := seen[row.WarehouseID]; ok {
			out[i] = row
			continue
		}
		seen[row.WarehouseID] = len(out)
		out = append(out, row)
	}
	if out == nil {
		out = []contract.Warehouse{}
	}
	return out
}

func dedupeMethods(rows []contract.Method) []contract.Method {
	seen := map[int64]int{}
	var out []contract.Method
	for _, row := range rows {
		if i, ok := seen[row.MethodID]; ok {
			out[i] = row
			continue
		}
		seen[row.MethodID] = len(out)
		out = append(out, row)
	}
	if out == nil {
		out = []contract.Method{}
	}
	return out
}

func trimOp(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\n' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\n' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}
