package domain

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

const (
	warehouseListPath  = "/v2/warehouse/list"
	warehouseStockPath = "/v2/product/info/stocks-by-warehouse/fbs"
)

type WarehousesRequest struct {
	StoreID string
	SKUs    []int64
}

func DecodeWarehouses(raw []byte) (WarehousesRequest, error) {
	m, err := object(raw, "store_id", "skus")
	if err != nil {
		return WarehousesRequest{}, err
	}
	store, ok, err := rawString(m, "store_id")
	if err != nil || !ok {
		return WarehousesRequest{}, errJSON
	}
	req := WarehousesRequest{StoreID: store, SKUs: []int64{}}
	if rawSKUs, ok := m["skus"]; ok {
		if json.Unmarshal(rawSKUs, &req.SKUs) != nil {
			return WarehousesRequest{}, errJSON
		}
	} else {
		return WarehousesRequest{}, errJSON
	}
	return req, nil
}

type warehouseView struct {
	WarehouseID int64  `json:"warehouse_id"`
	Name        string `json:"name"`
	Status      string `json:"status"`
	IsActive    bool   `json:"is_active"`
	IsRFBS      bool   `json:"is_rfbs"`
}

type warehouseStock struct {
	OfferID     string `json:"offer_id"`
	SKU         int64  `json:"sku"`
	WarehouseID int64  `json:"warehouse_id"`
	Present     int64  `json:"present"`
	Reserved    int64  `json:"reserved"`
}

func Warehouses(req WarehousesRequest, fetch Fetch) (json.RawMessage, *contract.Fail) {
	body, _ := compact(map[string]any{"warehouse_ids": []int64{}})
	page := fetch("POST", warehouseListPath, body)
	if f := readPage(page, "读取 Ozon 仓库列表", warehouseListPath, contract.CodeProducts); f != nil {
		return nil, f
	}
	rows := arr(nested(asObject(page.Body), "result"), "warehouses")
	if rows == nil {
		rows = arr(asObject(page.Body), "warehouses")
	}
	houses := make([]warehouseView, 0, len(rows))
	for _, row := range rows {
		id := fieldI64(row, "warehouse_id")
		if id <= 0 {
			continue
		}
		status := fieldString(row, "status")
		houses = append(houses, warehouseView{
			WarehouseID: id, Name: fieldString(row, "name"), Status: status,
			IsActive: status == "created", IsRFBS: fieldBool(row, "is_rfbs"),
		})
	}
	var stocks []warehouseStock
	skus := positiveSKUs(req.SKUs)
	if len(skus) > 0 {
		var f *contract.Fail
		stocks, f = warehouseStocks(skus, fetch)
		if f != nil {
			return nil, f
		}
	}
	if stocks == nil {
		stocks = []warehouseStock{}
	}
	present := map[int64]int64{}
	for _, st := range stocks {
		present[st.WarehouseID] += st.Present
	}
	sort.Slice(houses, func(i, j int) bool {
		if houses[i].IsActive != houses[j].IsActive {
			return houses[i].IsActive
		}
		if present[houses[i].WarehouseID] != present[houses[j].WarehouseID] {
			return present[houses[i].WarehouseID] > present[houses[j].WarehouseID]
		}
		return houses[i].Name < houses[j].Name
	})
	return mustData(struct {
		Warehouses []warehouseView  `json:"warehouses"`
		Stocks     []warehouseStock `json:"stocks"`
	}{Warehouses: houses, Stocks: stocks}), nil
}

func positiveSKUs(ids []int64) []int64 {
	seen := map[int64]struct{}{}
	var out []int64
	for _, id := range ids {
		if id <= 0 {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func warehouseStocks(skus []int64, fetch Fetch) ([]warehouseStock, *contract.Fail) {
	var out []warehouseStock
	var cursor string
	skuText := make([]string, len(skus))
	for i, id := range skus {
		skuText[i] = strconv.FormatInt(id, 10)
	}
	for page := 0; page < maxStockPages; page++ {
		body := map[string]any{"limit": stockPageLimit, "sku": skuText}
		if cursor != "" {
			body["cursor"] = cursor
		}
		raw, _ := compact(body)
		got := fetch("POST", warehouseStockPath, raw)
		if f := readPage(got, "读取所选商品仓库库存", warehouseStockPath, contract.CodeProducts); f != nil {
			return nil, f
		}
		root := asObject(got.Body)
		rows := arr(root, "products")
		if rows == nil {
			rows = arr(nested(root, "result"), "products")
		}
		for _, row := range rows {
			id := fieldI64(row, "warehouse_id")
			if id <= 0 {
				continue
			}
			out = append(out, warehouseStock{
				OfferID: fieldString(row, "offer_id"), SKU: fieldI64(row, "sku"),
				WarehouseID: id, Present: fieldI64(row, "present"), Reserved: fieldI64(row, "reserved"),
			})
		}
		if !fieldBool(root, "has_next") && strings.TrimSpace(fieldString(root, "cursor")) == "" {
			return out, nil
		}
		next := strings.TrimSpace(fieldString(root, "cursor"))
		if next == "" || next == cursor || len(rows) == 0 {
			return out, nil
		}
		cursor = next
	}
	return nil, &contract.Fail{Status: 502, Code: contract.CodeProducts, Message: "所选商品仓库库存超出读取页数上限，请减少选择后重试"}
}
