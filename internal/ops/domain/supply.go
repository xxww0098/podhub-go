package domain

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

const (
	supplyListPath    = "/v3/supply-order/list"
	supplyCounterPath = "/v1/supply-order/status/counter"
	supplyGetPath     = "/v3/supply-order/get"
	supplyBundlePath  = "/v1/supply-order/bundle"
	warehousesPath    = "/v1/supplier/available_warehouses"
	stockOnWhPath     = "/v2/analytics/stock_on_warehouses"
	orderPageLimit    = 20
	bundlePageLimit   = 100
	maxBundlePages    = 20
	stockPageLimit    = 1000
	maxStockPages     = 20
)

var allOrderStates = []string{
	"DATA_FILLING", "READY_TO_SUPPLY", "ACCEPTED_AT_SUPPLY_WAREHOUSE", "IN_TRANSIT",
	"ACCEPTANCE_AT_STORAGE_WAREHOUSE", "REPORTS_CONFIRMATION_AWAITING", "REPORT_REJECTED",
	"COMPLETED", "REJECTED_AT_SUPPLY_WAREHOUSE", "CANCELLED", "OVERDUE",
}

type SupplyListRequest struct {
	StoreID              string
	LastID               string
	States               []string
	DocumentNumberSearch string
}

func DecodeSupplyList(raw []byte) (SupplyListRequest, error) {
	m, err := object(raw, "store_id", "last_id", "states", "document_number_search")
	if err != nil {
		return SupplyListRequest{}, err
	}
	store, ok, err := rawString(m, "store_id")
	if err != nil || !ok {
		return SupplyListRequest{}, errJSON
	}
	last, err := optString(m, "last_id")
	if err != nil {
		return SupplyListRequest{}, err
	}
	doc, err := optString(m, "document_number_search")
	if err != nil {
		return SupplyListRequest{}, err
	}
	req := SupplyListRequest{StoreID: store}
	if last != nil {
		req.LastID = strings.TrimSpace(*last)
	}
	if doc != nil {
		req.DocumentNumberSearch = strings.TrimSpace(*doc)
	}
	if rawStates, ok := m["states"]; ok && string(rawStates) != "null" {
		if err := json.Unmarshal(rawStates, &req.States); err != nil {
			return SupplyListRequest{}, errJSON
		}
	}
	return req, nil
}

// ListFilterStates returns the short names sent to Ozon. Unknown names are 400.
func ListFilterStates(states []string) ([]string, *contract.Fail) {
	if len(states) == 0 {
		out := make([]string, len(allOrderStates))
		copy(out, allOrderStates)
		return out, nil
	}
	known := map[string]struct{}{}
	for _, s := range allOrderStates {
		known[s] = struct{}{}
	}
	out := make([]string, 0, len(states))
	seen := map[string]struct{}{}
	for _, raw := range states {
		short := strings.TrimPrefix(strings.TrimSpace(raw), "ORDER_STATE_")
		if _, ok := known[short]; !ok {
			return nil, contract.Validation("未知供货单状态：" + strings.TrimSpace(raw))
		}
		if _, ok := seen[short]; ok {
			continue
		}
		seen[short] = struct{}{}
		out = append(out, short)
	}
	return out, nil
}

type supplyOrder struct {
	OrderID              string `json:"order_id"`
	OrderNumber          string `json:"order_number"`
	State                string `json:"state"`
	CreatedDate          string `json:"created_date"`
	TimeslotFrom         string `json:"timeslot_from"`
	TimeslotTo           string `json:"timeslot_to"`
	TimeslotTimezone     string `json:"timeslot_timezone"`
	TargetWarehouseID    string `json:"target_warehouse_id"`
	TargetWarehouseName  string `json:"target_warehouse_name"`
	DropoffWarehouseName string `json:"dropoff_warehouse_name"`
	ItemCount            int64  `json:"item_count"`
	SKUCount             int64  `json:"sku_count"`
	ItemCountError       string `json:"item_count_error"`
}

type statusCount struct {
	State string `json:"state"`
	Count int32  `json:"count"`
}

type supplyListView struct {
	Orders       []supplyOrder `json:"orders"`
	LastID       string        `json:"last_id"`
	HasMore      bool          `json:"has_more"`
	StatusCounts []statusCount `json:"status_counts"`
}

func SupplyOrders(req SupplyListRequest, states []string, fetch Fetch) (json.RawMessage, *contract.Fail) {
	filter := map[string]any{"states": states}
	if req.DocumentNumberSearch != "" {
		filter["document_number_search"] = req.DocumentNumberSearch
	}
	body := map[string]any{
		"filter":   filter,
		"limit":    orderPageLimit,
		"sort_by":  "ORDER_CREATION",
		"sort_dir": "DESC",
	}
	if req.LastID != "" {
		body["last_id"] = req.LastID
	}
	raw, _ := compact(body)
	listPage := fetch("POST", supplyListPath, raw)
	counterPage := fetch("POST", supplyCounterPath, []byte(`{}`))
	if f := readPage(listPage, "读取供货单列表", supplyListPath, contract.CodeSupply); f != nil {
		return nil, f
	}
	if f := readPage(counterPage, "读取供货单状态计数", supplyCounterPath, contract.CodeSupply); f != nil {
		return nil, f
	}
	listRoot := asObject(listPage.Body)
	ids := orderIDs(listRoot)
	for _, id := range ids {
		if id <= 0 {
			return nil, &contract.Fail{Status: 502, Code: contract.CodeSupply, Message: "Ozon 返回了无效的供货单编号，未展示不完整列表"}
		}
	}
	next := strings.TrimSpace(fieldString(listRoot, "last_id"))
	counts := projectCounts(asObject(counterPage.Body))
	if len(ids) == 0 {
		return mustData(supplyListView{Orders: []supplyOrder{}, LastID: next, HasMore: false, StatusCounts: counts}), nil
	}
	getBody, _ := compact(map[string]any{"order_ids": ids})
	detail := fetch("POST", supplyGetPath, getBody)
	if f := readPage(detail, "读取供货单详情", supplyGetPath, contract.CodeSupply); f != nil {
		return nil, f
	}
	orders := arr(asObject(detail.Body), "orders")
	byID := map[int64]map[string]json.RawMessage{}
	for _, row := range orders {
		byID[fieldI64(row, "order_id")] = row
	}
	out := make([]supplyOrder, 0, len(ids))
	for _, id := range ids {
		row, ok := byID[id]
		if !ok {
			return nil, &contract.Fail{Status: 502, Code: contract.CodeSupply, Message: "Ozon 未返回全部供货单详情，未展示不完整列表"}
		}
		out = append(out, projectOrder(row, fetch))
	}
	return mustData(supplyListView{
		Orders: out, LastID: next,
		HasMore:      len(ids) >= orderPageLimit && next != "",
		StatusCounts: counts,
	}), nil
}

func orderIDs(root map[string]json.RawMessage) []int64 {
	raw, ok := root["order_ids"]
	if !ok {
		return nil
	}
	var nums []json.Number
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	if dec.Decode(&nums) != nil {
		var as []int64
		_ = json.Unmarshal(raw, &as)
		return as
	}
	out := make([]int64, 0, len(nums))
	for _, n := range nums {
		v, err := n.Int64()
		if err != nil {
			f, _ := n.Float64()
			v = int64(f)
		}
		out = append(out, v)
	}
	return out
}

func projectCounts(root map[string]json.RawMessage) []statusCount {
	rows := arr(root, "items")
	out := make([]statusCount, 0, len(rows))
	for _, row := range rows {
		n := fieldI64(row, "count")
		state := strings.TrimPrefix(strings.TrimSpace(fieldString(row, "order_state")), "ORDER_STATE_")
		if n <= 0 || state == "" {
			continue
		}
		out = append(out, statusCount{State: state, Count: int32(n)})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].State < out[j].State
	})
	return out
}

func projectOrder(row map[string]json.RawMessage, fetch Fetch) supplyOrder {
	id := fieldI64(row, "order_id")
	state := strings.TrimPrefix(strings.TrimSpace(fieldString(row, "state")), "ORDER_STATE_")
	slot := nested(nested(row, "timeslot"), "timeslot")
	tz := nested(nested(row, "timeslot"), "timezone_info")
	zone := strings.TrimSpace(fieldString(tz, "iana_name"))
	if zone == "" {
		zone = fieldString(tz, "offset")
	}
	whID, whName, drop := targetWarehouse(row)
	items, skus, errText := bundleCounts(row, fetch)
	return supplyOrder{
		OrderID: strconv.FormatInt(id, 10), OrderNumber: fieldString(row, "order_number"), State: state,
		CreatedDate:  fieldString(row, "created_date"),
		TimeslotFrom: fieldString(slot, "from"), TimeslotTo: fieldString(slot, "to"), TimeslotTimezone: zone,
		TargetWarehouseID: whID, TargetWarehouseName: whName, DropoffWarehouseName: drop,
		ItemCount: items, SKUCount: skus, ItemCountError: errText,
	}
}

func targetWarehouse(row map[string]json.RawMessage) (id, name, drop string) {
	supplies := arr(row, "supplies")
	for _, s := range supplies {
		wh := nested(s, "storage_warehouse")
		n := strings.TrimSpace(fieldString(wh, "name"))
		wid := fieldI64(wh, "warehouse_id")
		if n != "" || wid > 0 {
			if wid > 0 {
				id = strconv.FormatInt(wid, 10)
			}
			return id, n, dropName(row)
		}
	}
	d := nested(row, "dropoff_warehouse")
	wid := fieldI64(d, "warehouse_id")
	if strings.TrimSpace(fieldString(d, "name")) != "" || wid > 0 {
		if wid > 0 {
			id = strconv.FormatInt(wid, 10)
		}
		return id, strings.TrimSpace(fieldString(d, "name")), strings.TrimSpace(fieldString(d, "name"))
	}
	return "", "", ""
}

func dropName(row map[string]json.RawMessage) string {
	return strings.TrimSpace(fieldString(nested(row, "dropoff_warehouse"), "name"))
}

func bundleCounts(row map[string]json.RawMessage, fetch Fetch) (items, skus int64, errText string) {
	var ids []string
	for _, s := range arr(row, "supplies") {
		if id := strings.TrimSpace(fieldString(s, "bundle_id")); id != "" {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return 0, 0, ""
	}
	seenSKU := map[string]struct{}{}
	var cursor string
	for page := 0; page < maxBundlePages; page++ {
		body := map[string]any{"bundle_ids": ids, "limit": bundlePageLimit}
		if cursor != "" {
			body["last_id"] = cursor
		}
		raw, _ := compact(body)
		got := fetch("POST", supplyBundlePath, raw)
		if f := readPage(got, "读取供货明细", supplyBundlePath, contract.CodeSupply); f != nil {
			return 0, 0, f.Message
		}
		root := asObject(got.Body)
		rows := arr(root, "items")
		if fieldBool(root, "has_next") && len(rows) == 0 {
			return 0, 0, "Ozon 返回了空的供货明细续页，件数未知"
		}
		for _, item := range rows {
			q := fieldI64(item, "quantity")
			if q < 0 {
				q = 0
			}
			items += q
			sku := strings.TrimSpace(skuString(item))
			if sku != "" && sku != "0" {
				seenSKU[sku] = struct{}{}
			}
		}
		if !fieldBool(root, "has_next") {
			return items, int64(len(seenSKU)), ""
		}
		next := strings.TrimSpace(fieldString(root, "last_id"))
		if next == "" {
			return 0, 0, "Ozon 未返回供货明细续页游标，件数未知"
		}
		if next == cursor {
			return 0, 0, "Ozon 重复返回供货明细续页游标，件数未知"
		}
		cursor = next
	}
	return 0, 0, "Ozon 供货明细超过 20 页，件数未知"
}

type whStock struct {
	WarehouseID string `json:"warehouse_id"`
	Name        string `json:"name"`
	Present     int64  `json:"present"`
	Reserved    int64  `json:"reserved"`
	Promised    int64  `json:"promised"`
	SKUCount    int64  `json:"sku_count"`
}

func DecodeSupplyStocks(raw []byte) (string, error) {
	m, err := object(raw, "store_id")
	if err != nil {
		return "", err
	}
	store, ok, err := rawString(m, "store_id")
	if err != nil || !ok {
		return "", errJSON
	}
	return store, nil
}

func SupplyWarehouseStocks(fetch Fetch) (json.RawMessage, *contract.Fail) {
	roster := fetch("GET", warehousesPath, nil)
	if f := readPage(roster, "读取 Ozon 入库仓库", warehousesPath, contract.CodeSupply); f != nil {
		return nil, f
	}
	names := map[string]string{}
	for _, row := range arr(asObject(roster.Body), "result") {
		wh := nested(row, "warehouse")
		if wh == nil {
			wh = row
		}
		name := strings.TrimSpace(fieldString(wh, "name"))
		if name == "" {
			continue
		}
		id := strings.TrimSpace(fieldString(wh, "id"))
		if id == "" {
			if n := fieldI64(wh, "id"); n > 0 {
				id = strconv.FormatInt(n, 10)
			}
		}
		names[name] = id
	}
	agg := map[string]*whStock{}
	for name, id := range names {
		agg[name] = &whStock{WarehouseID: id, Name: name}
	}
	offset := 0
	for page := 0; page <= maxStockPages; page++ {
		raw, _ := compact(map[string]any{"limit": stockPageLimit, "offset": offset, "warehouse_type": "ALL"})
		got := fetch("POST", stockOnWhPath, raw)
		if f := readPage(got, "读取 Ozon 仓库存", stockOnWhPath, contract.CodeSupply); f != nil {
			return nil, f
		}
		rows := stockRows(got.Body)
		if page == maxStockPages && len(rows) > 0 {
			return nil, &contract.Fail{Status: 502, Code: contract.CodeSupply, Message: "Ozon 仓库存超过 20000 行，未展示不完整汇总"}
		}
		for _, row := range rows {
			name := strings.TrimSpace(fieldString(row, "warehouse_name"))
			if name == "" {
				continue
			}
			slot := agg[name]
			if slot == nil {
				slot = &whStock{Name: name}
				agg[name] = slot
			}
			slot.Present = satAdd(slot.Present, fieldI64(row, "free_to_sell_amount"))
			slot.Reserved = satAdd(slot.Reserved, fieldI64(row, "reserved_amount"))
			slot.Promised = satAdd(slot.Promised, fieldI64(row, "promised_amount"))
			slot.SKUCount = satAdd(slot.SKUCount, 1)
		}
		if len(rows) < stockPageLimit {
			break
		}
		offset += len(rows)
	}
	out := make([]whStock, 0, len(agg))
	for _, row := range agg {
		out = append(out, *row)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Present != out[j].Present {
			return out[i].Present > out[j].Present
		}
		return out[i].Name < out[j].Name
	})
	return mustData(struct {
		Warehouses []whStock `json:"warehouses"`
	}{Warehouses: out}), nil
}

func stockRows(body string) []map[string]json.RawMessage {
	root := asObject(body)
	if rows := arr(nested(root, "result"), "rows"); rows != nil {
		return rows
	}
	if rows := arr(root, "rows"); rows != nil {
		return rows
	}
	return arr(nested(root, "result"), "items")
}

func satAdd(a, b int64) int64 {
	if b > 0 && a > (1<<63-1)-b {
		return 1<<63 - 1
	}
	if b < 0 && a < (-1<<63)-b {
		return -1 << 63
	}
	return a + b
}
