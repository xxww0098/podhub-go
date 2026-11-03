package domain

import (
	"bytes"
	"encoding/json"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

var readPriceAmount = regexp.MustCompile(`^(0|[1-9]\d{0,9})(\.\d+)?$`)

// Observe is the read-only reconcile probe. It never sends a write.
func Observe(kind string, body []byte, fetch Fetch, promotions contract.PromotionRead) (string, string) {
	if len(bytes.TrimSpace(body)) == 0 {
		return "indeterminate", "账本缺少可复核的请求内容"
	}
	switch kind {
	case "chat_send":
		return observeChat(body, fetch)
	case "product_mutation":
		return observeMutation(body, fetch, promotions)
	default:
		return "indeterminate", "未知的 Seller 写类型 " + kind + "，无法只读核对"
	}
}

func observeChat(body []byte, _ Fetch) (string, string) {
	var req ChatSendRequest
	if json.Unmarshal(body, &req) != nil || strings.TrimSpace(req.ChatID) == "" {
		return "indeterminate", "持久化的客服消息无法解析：invalid"
	}
	return "indeterminate", "会话 " + req.ChatID + " 缺少可归属于本次发送的消息回执；相同文本不能证明已发送，请读取会话人工核对"
}

func observeMutation(body []byte, fetch Fetch, promotions contract.PromotionRead) (string, string) {
	var head struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(body, &head) != nil || head.Kind == "" {
		return "indeterminate", "持久化的商品操作无法解析：invalid"
	}
	switch head.Kind {
	case "price":
		return observePrice(body, fetch)
	case "stock":
		return observeStock(body, fetch)
	case "delete":
		return observeDelete(body, fetch)
	case "promotion_join", "promotion_leave":
		intent, fail := promotionIntentOf(Mutation{Kind: head.Kind, Raw: body})
		if fail != nil {
			return "indeterminate", fail.Message
		}
		return observePromotion(intent, promotions)
	default:
		return "indeterminate", "持久化的商品操作无法解析：unsupported " + head.Kind
	}
}

func observePrice(body []byte, fetch Fetch) (string, string) {
	var req struct {
		Items []priceItem `json:"items"`
	}
	if json.Unmarshal(body, &req) != nil || validatePrice(body) != nil {
		return "indeterminate", "持久化的改价请求无效"
	}
	ids := make([]int64, 0, len(req.Items))
	wanted := make(map[int64]priceItem, len(req.Items))
	for _, item := range req.Items {
		ids = append(ids, item.ProductID)
		wanted[item.ProductID] = item
	}
	raw, _ := compact(map[string]any{"filter": map[string]any{"product_id": ids, "visibility": "ALL"}, "limit": 1000})
	page := fetch("POST", pricesPath, raw)
	if page.Err != nil || page.Status < 200 || page.Status >= 300 {
		return "indeterminate", "read-only probe failed: " + readMessage("读取商品价格", pricesPath, page.Status, page.Body, page.Err)
	}
	var reply struct {
		Items *[]struct {
			ProductID int64     `json:"product_id"`
			OfferID   string    `json:"offer_id"`
			Price     priceItem `json:"price"`
		} `json:"items"`
		Cursor string `json:"cursor"`
	}
	if json.Unmarshal([]byte(page.Body), &reply) != nil || reply.Items == nil || len(*reply.Items) != len(req.Items) || reply.Cursor != "" {
		return "indeterminate", "价格核对响应不完整，请稍后再核对"
	}
	seen := make(map[int64]bool, len(req.Items))
	observations := make([]string, 0, len(req.Items))
	matches := true
	for _, row := range *reply.Items {
		item, ok := wanted[row.ProductID]
		if len(row.Price.Price) > 64 || len(row.Price.OldPrice) > 64 || !readPriceAmount.MatchString(row.Price.Price) || !readPriceAmount.MatchString(row.Price.OldPrice) {
			return "indeterminate", "价格核对响应包含无效金额"
		}
		price, pOK := new(big.Rat).SetString(row.Price.Price)
		old, oOK := new(big.Rat).SetString(row.Price.OldPrice)
		if !ok || seen[row.ProductID] || row.OfferID != strings.TrimSpace(item.OfferID) || !pOK || !oOK || price.Sign() <= 0 || old.Sign() < 0 || !priceCurrency.MatchString(row.Price.CurrencyCode) {
			return "indeterminate", "价格核对响应包含无效或不匹配的商品"
		}
		seen[row.ProductID] = true
		wantPrice, _ := new(big.Rat).SetString(strings.TrimSpace(item.Price))
		wantOld, _ := new(big.Rat).SetString(strings.TrimSpace(item.OldPrice))
		matches = matches && price.Cmp(wantPrice) == 0 && old.Cmp(wantOld) == 0 && row.Price.CurrencyCode == strings.TrimSpace(item.CurrencyCode)
		observations = append(observations, strconv.FormatInt(row.ProductID, 10)+":"+price.RatString()+":"+old.RatString()+":"+row.Price.CurrencyCode)
	}
	sort.Strings(observations)
	summary := "商品价格核对：" + strings.Join(observations, ",")
	if matches {
		return "applied", summary
	}
	return "contradicted", summary
}

func observeStock(body []byte, fetch Fetch) (string, string) {
	var req struct {
		Items []stockItem `json:"items"`
	}
	if json.Unmarshal(body, &req) != nil || len(req.Items) == 0 {
		return "indeterminate", "持久化的商品操作无法解析：invalid"
	}
	seen := map[int64]bool{}
	skus := make([]int64, 0, len(req.Items))
	for _, it := range req.Items {
		if it.SKU <= 0 || it.WarehouseID <= 0 {
			return "indeterminate", "本次库存操作缺少可用于只读核对的 SKU 或仓库"
		}
		if !seen[it.SKU] {
			seen[it.SKU] = true
			skus = append(skus, it.SKU)
		}
	}
	sort.Slice(skus, func(i, j int) bool { return skus[i] < skus[j] })
	skuText := make([]string, len(skus))
	for i, id := range skus {
		skuText[i] = strconv.FormatInt(id, 10)
	}
	observed := map[[2]int64]int64{}
	var cursor string
	for page := 0; page < maxStockPages; page++ {
		payload := map[string]any{"sku": skuText, "limit": stockPageLimit}
		if cursor != "" {
			payload["cursor"] = cursor
		}
		raw, _ := compact(payload)
		got := fetch("POST", warehouseStockPath, raw)
		if got.Err != nil || got.Status < 200 || got.Status >= 300 {
			return "indeterminate", "read-only probe failed: " + readMessage("读取库存", warehouseStockPath, got.Status, got.Body, got.Err)
		}
		root := asObject(got.Body)
		rows := arr(root, "products")
		if rows == nil {
			rows = arr(nested(root, "result"), "products")
		}
		if rows == nil {
			return "indeterminate", "库存只读核对响应无效：products 必须是数组"
		}
		for _, row := range rows {
			warehouseID, ok := presentI64(row, "warehouse_id")
			if !ok || warehouseID <= 0 {
				return "indeterminate", "库存只读核对响应包含无效仓库"
			}
			sku, ok := presentI64(row, "sku")
			if !ok || sku <= 0 {
				return "indeterminate", "库存只读核对响应包含无效 SKU"
			}
			present, ok := presentI64(row, "present")
			if !ok || present < 0 {
				return "indeterminate", "库存只读核对响应包含无效现存量"
			}
			key := [2]int64{sku, warehouseID}
			if _, duplicate := observed[key]; duplicate {
				return "indeterminate", "库存只读核对响应包含重复商品仓库"
			}
			observed[key] = present
		}
		next := strings.TrimSpace(fieldString(root, "cursor"))
		if !fieldBool(root, "has_next") && next == "" {
			return decideStock(req.Items, observed)
		}
		if next == "" || next == cursor || len(rows) == 0 {
			return "indeterminate", "库存只读核对响应分页不完整"
		}
		cursor = next
	}
	return "indeterminate", "库存只读核对超出读取页数上限"
}

// decideStock compares the requested absolute stock with Ozon's current
// present count for the same SKU and warehouse.
func decideStock(items []stockItem, observed map[[2]int64]int64) (string, string) {
	matches := true
	lines := make([]string, 0, len(items))
	for _, it := range items {
		present, ok := observed[[2]int64{it.SKU, it.WarehouseID}]
		if !ok {
			return "indeterminate", "库存只读核对缺少 SKU " + itoa(int(it.SKU)) + " 在仓库 " + itoa(int(it.WarehouseID)) + " 的记录"
		}
		if present != it.Stock {
			matches = false
		}
		lines = append(lines, itoa(int(it.SKU))+"/"+itoa(int(it.WarehouseID))+" 请求="+itoa(int(it.Stock))+" 当前="+itoa(int(present)))
	}
	sort.Strings(lines)
	summary := "库存核对：" + strings.Join(lines, ",")
	if matches {
		return "applied", summary
	}
	return "contradicted", summary
}

// presentI64 tells a missing, null, or mistyped value apart from a real zero.
func presentI64(m map[string]json.RawMessage, key string) (int64, bool) {
	raw, ok := m[key]
	if !ok {
		return 0, false
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || (raw[0] != '-' && (raw[0] < '0' || raw[0] > '9')) {
		return 0, false
	}
	var n json.Number
	if json.Unmarshal(raw, &n) != nil {
		return 0, false
	}
	v, err := n.Int64()
	if err != nil {
		return 0, false
	}
	return v, true
}

func observeDelete(body []byte, fetch Fetch) (string, string) {
	var req struct {
		OfferIDs []string `json:"offer_ids"`
	}
	if json.Unmarshal(body, &req) != nil {
		return "indeterminate", "持久化的商品操作无法解析：invalid"
	}
	raw, _ := compact(map[string]any{"filter": map[string]any{"offer_id": req.OfferIDs, "visibility": "ALL"}, "limit": 1000})
	page := fetch("POST", productListPath, raw)
	if page.Err != nil || page.Status < 200 || page.Status >= 300 {
		return "indeterminate", "read-only probe failed: " + readMessage("读取商品数据", productListPath, page.Status, page.Body, page.Err)
	}
	rows := arr(nested(asObject(page.Body), "result"), "items")
	if rows == nil {
		return "indeterminate", "商品只读核对响应无效：result.items 必须是数组"
	}
	if len(rows) == 0 {
		return "applied_by_absence", itoa(len(req.OfferIDs)) + " 个货号均已不在 Ozon 商品列表"
	}
	var still []string
	for _, row := range rows {
		still = append(still, fieldString(row, "offer_id"))
	}
	return "contradicted", "仍存在的货号：" + strings.Join(still, ", ")
}
