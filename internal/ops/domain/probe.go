package domain

import (
	"bytes"
	"encoding/json"
	"strings"
)

// Observe is the read-only reconcile probe. It never sends a write.
func Observe(kind string, body []byte, fetch Fetch) (string, string) {
	if len(bytes.TrimSpace(body)) == 0 {
		return "indeterminate", "账本缺少可复核的请求内容"
	}
	switch kind {
	case "chat_send":
		return observeChat(body, fetch)
	case "product_mutation":
		return observeMutation(body, fetch)
	default:
		return "indeterminate", "未知的 Seller 写类型 " + kind + "，无法只读核对"
	}
}

func observeChat(body []byte, fetch Fetch) (string, string) {
	var req ChatSendRequest
	if json.Unmarshal(body, &req) != nil || strings.TrimSpace(req.ChatID) == "" {
		return "indeterminate", "持久化的客服消息无法解析：invalid"
	}
	raw, _ := compact(map[string]any{"chat_id": req.ChatID, "direction": "Backward", "limit": 50})
	page := fetch("POST", chatHistory, raw)
	if page.Err != nil || page.Status < 200 || page.Status >= 300 {
		return "indeterminate", "read-only probe failed: " + readMessage("读取 Ozon 聊天记录", chatHistory, page.Status, page.Body, page.Err)
	}
	for _, row := range arr(asObject(page.Body), "messages") {
		user := strings.ToLower(fieldString(nested(row, "user"), "type"))
		var data []string
		if raw, ok := row["data"]; ok {
			_ = json.Unmarshal(raw, &data)
		}
		if user == "seller" && len(data) == 1 && data[0] == req.Text {
			return "applied", "会话 " + req.ChatID + " 已出现该条卖家消息"
		}
	}
	return "indeterminate", "会话 " + req.ChatID + " 最近 50 条中未见该条卖家消息"
}

func observeMutation(body []byte, fetch Fetch) (string, string) {
	var head struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(body, &head) != nil || head.Kind == "" {
		return "indeterminate", "持久化的商品操作无法解析：invalid"
	}
	switch head.Kind {
	case "stock":
		return observeStock(body, fetch)
	case "delete":
		return observeDelete(body, fetch)
	default:
		return "indeterminate", "持久化的商品操作无法解析：unsupported " + head.Kind
	}
}

func observeStock(body []byte, fetch Fetch) (string, string) {
	var req struct {
		Items []stockItem `json:"items"`
	}
	if json.Unmarshal(body, &req) != nil {
		return "indeterminate", "持久化的商品操作无法解析：invalid"
	}
	var skus []string
	for _, it := range req.Items {
		if it.SKU > 0 {
			skus = append(skus, itoa(int(it.SKU)))
		}
	}
	if len(skus) == 0 {
		return "indeterminate", "本次库存操作没有可用于只读核对的 SKU"
	}
	raw, _ := compact(map[string]any{"sku": skus, "limit": 1000})
	page := fetch("POST", "/v2/product/info/stocks-by-warehouse/fbs", raw)
	if page.Err != nil || page.Status < 200 || page.Status >= 300 {
		return "indeterminate", "read-only probe failed: " + readMessage("读取库存", "/v2/product/info/stocks-by-warehouse/fbs", page.Status, page.Body, page.Err)
	}
	return "indeterminate", "库存只读核对已完成，等待下一次相同观察"
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
	if len(rows) == 0 {
		return "applied_by_absence", itoa(len(req.OfferIDs)) + " 个货号均已不在 Ozon 商品列表"
	}
	var still []string
	for _, row := range rows {
		still = append(still, fieldString(row, "offer_id"))
	}
	return "contradicted", "仍存在的货号：" + strings.Join(still, ", ")
}
