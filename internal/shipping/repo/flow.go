package repo

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/xxww0098/podhub-go/internal/shipping/contract"
	"github.com/xxww0098/podhub-go/internal/shipping/domain"
)

const killSentence = "OZON_WRITE_KILL_SWITCH 已启用，Ozon 实时写入已停止"

func writeBlocked(ozon domain.Ozon) error {
	type gate interface{ Blocked() error }
	g, ok := ozon.(gate)
	if !ok || g == nil {
		return nil
	}
	if err := g.Blocked(); err != nil {
		return contract.WritesDisabled(killSentence)
	}
	return nil
}

func killSwitch(err error) error {
	if err == nil {
		return nil
	}
	if strings.Contains(err.Error(), "Ozon 实时写入已停止") {
		return contract.WritesDisabled(killSentence)
	}
	return nil
}

func post(ctx context.Context, ozon domain.Ozon, secret shopSecret, path string, body []byte, write bool) (int, []byte, error) {
	if ozon == nil {
		return 0, nil, contract.Gateway("")
	}
	return ozon.Post(ctx, path, body, write, secret.ClientID, secret.APIKey)
}

func matchWarehouse(names []domain.WarehouseName, want string) *domain.WarehouseName {
	for _, name := range names {
		if name.Name == want || name.WarehouseName == want {
			n := name
			return &n
		}
	}
	return nil
}

func (r Repo) verify(ctx context.Context, row row, preset domain.Preset, secret shopSecret, ozon domain.Ozon, warehouse, known *int64, mutate int32, fallback string, now int64, opID string) (json.RawMessage, error) {
	if warehouse == nil {
		status := fallback
		if mutate >= 1 {
			status = "unknown"
		}
		if err := r.persist(ctx, row, status, mutate, nil, known, false, now, "verify"); err != nil {
			return nil, err
		}
		return r.diagnostic(ctx, row.Store, row.Preset, now)
	}
	methods, err := listMethods(ctx, ozon, secret, *warehouse)
	if err != nil {
		return nil, contract.Validation("仓库配送方式查询失败，请稍后重试")
	}
	chosen := domain.PickMethod(preset, *warehouse, known, methods)
	status := fallback
	var delivery *int64
	if chosen != nil {
		id := chosen.ID
		delivery = &id
		if strings.EqualFold(chosen.Status, "ACTIVE") {
			status = "succeeded"
		} else {
			status = "waiting"
		}
	}
	if opID != "" {
		if err := r.finish(ctx, row, status, mutate, "", opID, "verify", now); err != nil {
			return nil, err
		}
		if _, err := r.Pool.Exec(ctx, `
			UPDATE shipping_shop_injections
			SET warehouse_id = $3, delivery_method_id = $4, updated_at_ms = $5
			WHERE store_uuid = $1::uuid AND preset_id = $2`, row.Store, row.Preset, warehouse, delivery, now); err != nil {
			return nil, mapDB(err)
		}
	} else if err := r.persist(ctx, row, status, mutate, warehouse, delivery, false, now, "verify"); err != nil {
		return nil, err
	}
	return r.diagnostic(ctx, row.Store, row.Preset, now)
}

func (r Repo) poll(ctx context.Context, row row, preset domain.Preset, secret shopSecret, ozon domain.Ozon, ozonOp, opID string, now int64) error {
	body, _ := json.Marshal(map[string]string{"operation_id": ozonOp})
	status, resp, err := post(ctx, ozon, secret, "/v1/warehouse/operation/status", body, false)
	if stopped := killSwitch(err); stopped != nil {
		return stopped
	}
	if err != nil || status < 200 || status >= 300 {
		return r.finish(ctx, row, "unknown", 1, ozonOp, opID, "poll", now)
	}
	var parsed struct {
		Status string `json:"status"`
		Result struct {
			WarehouseID *int64 `json:"warehouse_id"`
		} `json:"result"`
	}
	if json.Unmarshal(resp, &parsed) != nil {
		return r.finish(ctx, row, "unknown", 1, ozonOp, opID, "poll", now)
	}
	switch strings.ToUpper(parsed.Status) {
	case "SUCCESS":
		id := parsed.Result.WarehouseID
		if id == nil {
			names, listErr := listWarehouses(ctx, ozon, secret)
			if listErr == nil {
				if found := matchWarehouse(names, preset.WarehouseName); found != nil {
					id = &found.WarehouseID
				}
			}
		}
		_, err := r.verify(ctx, row, preset, secret, ozon, id, nil, 1, "waiting", now, opID)
		return err
	case "WAITING", "IN_PROGRESS":
		return r.finish(ctx, row, "waiting", 1, ozonOp, opID, "poll", now)
	case "ERROR":
		return r.finish(ctx, row, "failed", 1, ozonOp, opID, "poll", now)
	default:
		return r.finish(ctx, row, "unknown", 1, ozonOp, opID, "poll", now)
	}
}

func listMethods(ctx context.Context, ozon domain.Ozon, secret shopSecret, warehouseID int64) ([]domain.DeliveryMethod, error) {
	body, _ := json.Marshal(map[string]any{
		"limit": 100,
		"filter": map[string]any{
			"warehouse_ids": []string{itoa(warehouseID)},
		},
	})
	status, resp, err := post(ctx, ozon, secret, "/v2/delivery-method/list", body, false)
	if err != nil || status < 200 || status >= 300 {
		return nil, errors.New("list")
	}
	var parsed struct {
		Methods []struct {
			ID          int64  `json:"id"`
			Name        string `json:"name"`
			Status      string `json:"status"`
			WarehouseID int64  `json:"warehouse_id"`
			Express     bool   `json:"is_express"`
		} `json:"delivery_methods"`
	}
	if json.Unmarshal(resp, &parsed) != nil {
		return nil, errors.New("decode")
	}
	out := make([]domain.DeliveryMethod, 0, len(parsed.Methods))
	for _, m := range parsed.Methods {
		out = append(out, domain.DeliveryMethod{
			ID: m.ID, Name: m.Name, Status: m.Status, WarehouseID: m.WarehouseID, Express: m.Express,
		})
	}
	return out, nil
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
