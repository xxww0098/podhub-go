package domain

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

const sellerNumberMax int64 = 9007199254740991

type Mutation struct {
	OperationID string
	StoreID     string
	Kind        string
	Raw         json.RawMessage
	Stored      []byte
}

type stockItem struct {
	ProductID   int64  `json:"product_id"`
	OfferID     string `json:"offer_id"`
	SKU         int64  `json:"sku"`
	WarehouseID int64  `json:"warehouse_id"`
	Stock       int64  `json:"stock"`
}

type priceItem struct {
	ProductID    int64  `json:"product_id"`
	OfferID      string `json:"offer_id"`
	Price        string `json:"price"`
	OldPrice     string `json:"old_price"`
	CurrencyCode string `json:"currency_code"`
}

type joinItem struct {
	ProductID   int64   `json:"product_id"`
	OfferID     string  `json:"offer_id"`
	ActionPrice float64 `json:"action_price"`
	Stock       float64 `json:"stock"`
}

type exitPrice struct {
	ProductID int64   `json:"product_id"`
	ExitPrice float64 `json:"exit_price"`
}

type leaveBody struct {
	ActionID   int64
	ProductIDs []int64
	ActionType string
	ExitPrices []exitPrice
}

func DecodeMutation(raw []byte) (Mutation, error) {
	m, err := object(raw, "operation_id", "store_id", "request")
	if err != nil {
		return Mutation{}, err
	}
	op, ok, err := rawString(m, "operation_id")
	if err != nil || !ok {
		return Mutation{}, errJSON
	}
	store, ok, err := rawString(m, "store_id")
	if err != nil || !ok {
		return Mutation{}, errJSON
	}
	req, ok := m["request"]
	if !ok {
		return Mutation{}, errJSON
	}
	body, err := object(req, "kind", "items", "product_ids", "offer_ids", "action_id", "action_type", "exit_prices")
	if err != nil {
		return Mutation{}, err
	}
	kind, ok, err := rawString(body, "kind")
	if err != nil || !ok {
		return Mutation{}, errJSON
	}
	stored, err := compact(json.RawMessage(req))
	if err != nil {
		return Mutation{}, err
	}
	return Mutation{OperationID: op, StoreID: store, Kind: kind, Raw: req, Stored: stored}, nil
}

func ValidateMutation(m Mutation) *contract.Fail {
	if _, ok := NormalizeUUID(m.OperationID); !ok {
		return contract.Validation("商品操作缺少有效 operation ID")
	}
	if strings.TrimSpace(m.StoreID) == "" {
		return contract.Validation("商品操作缺少目标店铺")
	}
	switch m.Kind {
	case "stock":
		return validateStock(m.Raw)
	case "price":
		return validatePrice(m.Raw)
	case "archive", "unarchive":
		return validateIDs(m.Raw, "归档操作每次必须包含 1–100 个有效商品", 100)
	case "delete":
		return validateOffers(m.Raw)
	case "promotion_join":
		return validateJoin(m.Raw)
	case "promotion_leave":
		return validateLeave(m.Raw)
	default:
		return contract.NotPorted()
	}
}

func sellerID(n int64) bool { return n >= 1 && n <= sellerNumberMax }

func finitePositive(s string) bool {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return err == nil && finite(f) && f > 0
}

func finiteNonNeg(s string) bool {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return err == nil && finite(f) && f >= 0
}

func validateStock(raw json.RawMessage) *contract.Fail {
	var body struct {
		Items []stockItem `json:"items"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return contract.NotPorted()
	}
	if len(body.Items) == 0 || len(body.Items) > 100 {
		return contract.Validation("库存操作每次必须包含 1–100 个商品仓库组合")
	}
	for _, it := range body.Items {
		if strings.TrimSpace(it.OfferID) == "" || !sellerID(it.ProductID) || it.WarehouseID <= 0 || it.Stock < 0 {
			return contract.Validation("库存操作包含无效商品、仓库或负数库存")
		}
	}
	return nil
}

func validatePrice(raw json.RawMessage) *contract.Fail {
	var body struct {
		Items []priceItem `json:"items"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return contract.NotPorted()
	}
	if len(body.Items) == 0 || len(body.Items) > 1000 {
		return contract.Validation("优惠操作每次必须包含 1–1000 个商品")
	}
	for _, it := range body.Items {
		if strings.TrimSpace(it.OfferID) == "" || it.ProductID <= 0 || strings.TrimSpace(it.CurrencyCode) == "" || !finitePositive(it.Price) || !finiteNonNeg(it.OldPrice) {
			return contract.Validation("优惠操作包含无效商品、币种或价格")
		}
	}
	return nil
}

func validateIDs(raw json.RawMessage, msg string, limit int) *contract.Fail {
	var body struct {
		ProductIDs []int64 `json:"product_ids"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return contract.NotPorted()
	}
	if len(body.ProductIDs) == 0 || len(body.ProductIDs) > limit {
		return contract.Validation(msg)
	}
	for _, id := range body.ProductIDs {
		if id <= 0 {
			return contract.Validation(msg)
		}
	}
	return nil
}

func validateOffers(raw json.RawMessage) *contract.Fail {
	var body struct {
		OfferIDs []string `json:"offer_ids"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return contract.NotPorted()
	}
	if len(body.OfferIDs) == 0 || len(body.OfferIDs) > 500 {
		return contract.Validation("删除操作每次必须包含 1–500 个有效货号")
	}
	for _, id := range body.OfferIDs {
		if strings.TrimSpace(id) == "" {
			return contract.Validation("删除操作每次必须包含 1–500 个有效货号")
		}
	}
	return nil
}

func validateJoin(raw json.RawMessage) *contract.Fail {
	var body struct {
		ActionID int64      `json:"action_id"`
		Items    []joinItem `json:"items"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return contract.NotPorted()
	}
	if !sellerID(body.ActionID) {
		return contract.Validation("加入活动缺少有效的活动 ID")
	}
	if len(body.Items) == 0 || len(body.Items) > 100 {
		return contract.Validation("加入活动每次必须包含 1–100 个商品")
	}
	for _, it := range body.Items {
		if strings.TrimSpace(it.OfferID) == "" || !sellerID(it.ProductID) || !finite(it.ActionPrice) || it.ActionPrice <= 0 || !finite(it.Stock) || it.Stock < 0 {
			return contract.Validation("加入活动包含无效商品、活动价或活动库存")
		}
	}
	return nil
}

func validateLeave(raw json.RawMessage) *contract.Fail {
	body, ok := parseLeave(raw)
	if !ok {
		return contract.NotPorted()
	}
	if !sellerID(body.ActionID) {
		return contract.Validation("退出活动缺少有效的活动 ID")
	}
	if len(body.ProductIDs) == 0 || len(body.ProductIDs) > 100 {
		return contract.Validation("退出活动每次必须包含 1–100 个有效商品")
	}
	set := map[int64]struct{}{}
	for _, id := range body.ProductIDs {
		if !sellerID(id) {
			return contract.Validation("退出活动每次必须包含 1–100 个有效商品")
		}
		set[id] = struct{}{}
	}
	for _, ex := range body.ExitPrices {
		if _, ok := set[ex.ProductID]; !ok || !sellerID(ex.ProductID) || !finite(ex.ExitPrice) || ex.ExitPrice <= 0 {
			return contract.Validation("退出活动包含无效的退出价")
		}
	}
	return nil
}

func parseLeave(raw json.RawMessage) (leaveBody, bool) {
	var body struct {
		ActionID   int64       `json:"action_id"`
		ProductIDs []int64     `json:"product_ids"`
		ActionType string      `json:"action_type"`
		ExitPrices []exitPrice `json:"exit_prices"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return leaveBody{}, false
	}
	return leaveBody{ActionID: body.ActionID, ProductIDs: body.ProductIDs, ActionType: body.ActionType, ExitPrices: body.ExitPrices}, true
}

type itemResult struct {
	Identity  string `json:"identity"`
	Succeeded bool   `json:"succeeded"`
	Message   string `json:"message"`
}

type mutationView struct {
	OperationID string       `json:"operation_id"`
	Items       []itemResult `json:"items"`
}

// Dispatch runs the Ozon calls for one already-inserted mutation.
// A decided HTTP failure is returned as *contract.Fail and should be settled.
// Unknown reports transport or 5xx/429; the caller marks the ledger unknown.
func Dispatch(m Mutation, fetch Fetch) (json.RawMessage, *contract.Fail, bool) {
	switch m.Kind {
	case "stock":
		return dispatchStock(m, fetch)
	case "price":
		return dispatchPrice(m, fetch)
	case "archive":
		return dispatchArchive(m, true, fetch)
	case "unarchive":
		return dispatchArchive(m, false, fetch)
	case "delete":
		return dispatchDelete(m, fetch)
	case "promotion_join":
		return dispatchJoin(m, fetch)
	case "promotion_leave":
		return dispatchLeave(m, fetch)
	default:
		return nil, contract.NotPorted(), false
	}
}

func viewOf(op string, items []itemResult) json.RawMessage {
	if items == nil {
		items = []itemResult{}
	}
	raw, _ := compact(mutationView{OperationID: strings.TrimSpace(op), Items: items})
	return raw
}

func dispatchStock(m Mutation, fetch Fetch) (json.RawMessage, *contract.Fail, bool) {
	var body struct {
		Items []stockItem `json:"items"`
	}
	_ = json.Unmarshal(m.Raw, &body)
	stocks := make([]map[string]any, 0, len(body.Items))
	for _, it := range body.Items {
		row := map[string]any{"stock": it.Stock, "warehouse_id": it.WarehouseID}
		if it.ProductID > 0 {
			row["product_id"] = it.ProductID
		} else {
			row["offer_id"] = it.OfferID
		}
		stocks = append(stocks, row)
	}
	raw, _ := compact(map[string]any{"stocks": stocks})
	page := fetch("POST", "/v2/products/stocks", raw)
	if und := undecided(page); und {
		return nil, writeUnknown(m.OperationID, page, "/v2/products/stocks"), true
	}
	if f := decided(page, "/v2/products/stocks"); f != nil {
		return nil, f, false
	}
	items := stockResults(body.Items, page.Body)
	if needsUnarchive(page.Body) {
		ids := make([]int64, 0, len(body.Items))
		for _, it := range body.Items {
			if it.ProductID > 0 {
				ids = append(ids, it.ProductID)
			}
		}
		restore, _ := compact(map[string]any{"product_id": ids})
		again := fetch("POST", "/v1/product/unarchive", restore)
		if und := undecided(again); und {
			return nil, writeUnknown(m.OperationID, again, "/v1/product/unarchive"), true
		}
		if again.Status >= 200 && again.Status < 300 {
			page = fetch("POST", "/v2/products/stocks", raw)
			if und := undecided(page); und {
				return nil, writeUnknown(m.OperationID, page, "/v2/products/stocks"), true
			}
			if f := decided(page, "/v2/products/stocks"); f != nil {
				return nil, f, false
			}
			items = stockResults(body.Items, page.Body)
		} else {
			msg := "商品已归档，无法修改库存"
			if strings.Contains(strings.ToLower(again.Body), "restore limit exceeded") || strings.Contains(strings.ToLower(again.Body), "total limit exceeded") {
				// keep the short message
			} else if t := strings.TrimSpace(again.Body); t != "" {
				msg = "商品已归档，无法修改库存：" + MessageZH(jsonMessage(again.Body))
			}
			for i := range items {
				items[i].Succeeded = false
				items[i].Message = msg
			}
		}
	}
	return viewOf(m.OperationID, items), nil, false
}

func needsUnarchive(body string) bool {
	low := strings.ToLower(body)
	return strings.Contains(low, "archived_product") || strings.Contains(low, "archived product") || strings.Contains(low, "архив")
}

func stockResults(items []stockItem, body string) []itemResult {
	out := make([]itemResult, 0, len(items))
	for _, it := range items {
		out = append(out, itemResult{Identity: strconv.FormatInt(it.ProductID, 10), Succeeded: true, Message: localizeStock(body)})
	}
	if len(out) == 1 && out[0].Message != "" && (strings.Contains(strings.ToLower(body), "archived") || strings.Contains(body, "архив") || strings.Contains(body, "discount_for_average") || strings.Contains(body, "TOO_MANY")) {
		out[0].Succeeded = false
	}
	return out
}

func localizeStock(body string) string {
	low := strings.ToLower(body)
	switch {
	case strings.Contains(low, "discount_for_average_price_is_too_small"):
		return "优惠率低于 Ozon 对当前价格区间的最低要求"
	case strings.Contains(body, "TOO_MANY_REQUESTS"):
		return "该商品在此仓库的库存改得太频繁，Ozon 暂时拒绝；请稍后重试"
	case strings.Contains(low, "archived_product") || strings.Contains(low, "archived product") || strings.Contains(low, "архив"):
		return "商品已归档，无法修改库存"
	default:
		if msg := jsonMessage(body); strings.TrimSpace(msg) != "" && (strings.Contains(body, "error") || strings.Contains(body, "errors")) {
			return MessageZH(msg)
		}
		return ""
	}
}

func dispatchPrice(m Mutation, fetch Fetch) (json.RawMessage, *contract.Fail, bool) {
	var body struct {
		Items []priceItem `json:"items"`
	}
	_ = json.Unmarshal(m.Raw, &body)
	prices := make([]map[string]any, 0, len(body.Items))
	for _, it := range body.Items {
		prices = append(prices, map[string]any{
			"product_id": it.ProductID, "offer_id": strings.TrimSpace(it.OfferID),
			"price": it.Price, "old_price": it.OldPrice, "currency_code": strings.TrimSpace(it.CurrencyCode),
		})
	}
	raw, _ := compact(map[string]any{"prices": prices})
	page := fetch("POST", "/v1/product/import/prices", raw)
	return settledItems(m, page, "/v1/product/import/prices", func() []itemResult {
		out := make([]itemResult, 0, len(body.Items))
		for _, it := range body.Items {
			out = append(out, itemResult{Identity: strings.TrimSpace(it.OfferID), Succeeded: true})
		}
		return out
	})
}

func dispatchArchive(m Mutation, archive bool, fetch Fetch) (json.RawMessage, *contract.Fail, bool) {
	var body struct {
		ProductIDs []int64 `json:"product_ids"`
	}
	_ = json.Unmarshal(m.Raw, &body)
	path := "/v1/product/unarchive"
	label := "Ozon 未确认恢复请求"
	if archive {
		path = "/v1/product/archive"
		label = "Ozon 未确认归档请求"
	}
	raw, _ := compact(map[string]any{"product_id": body.ProductIDs})
	page := fetch("POST", path, raw)
	return settledItems(m, page, path, func() []itemResult {
		ok := fieldBool(asObject(page.Body), "result")
		if nested(asObject(page.Body), "result") != nil {
			ok = true
		}
		if _, isBool := asObject(page.Body)["result"]; isBool {
			ok = fieldBool(asObject(page.Body), "result")
		}
		msg := ""
		if !ok {
			msg = label
		}
		out := make([]itemResult, 0, len(body.ProductIDs))
		for _, id := range body.ProductIDs {
			out = append(out, itemResult{Identity: strconv.FormatInt(id, 10), Succeeded: ok, Message: msg})
		}
		return out
	})
}

func dispatchDelete(m Mutation, fetch Fetch) (json.RawMessage, *contract.Fail, bool) {
	var body struct {
		OfferIDs []string `json:"offer_ids"`
	}
	_ = json.Unmarshal(m.Raw, &body)
	products := make([]map[string]string, 0, len(body.OfferIDs))
	for _, id := range body.OfferIDs {
		products = append(products, map[string]string{"offer_id": strings.TrimSpace(id)})
	}
	raw, _ := compact(map[string]any{"products": products})
	page := fetch("POST", "/v2/products/delete", raw)
	return settledItems(m, page, "/v2/products/delete", func() []itemResult {
		out := make([]itemResult, 0, len(body.OfferIDs))
		for _, id := range body.OfferIDs {
			out = append(out, itemResult{Identity: strings.TrimSpace(id), Succeeded: true})
		}
		return out
	})
}

type money struct {
	Amount   string `json:"amount"`
	Currency string `json:"currency"`
}

func moneyText(v float64) money {
	return money{Amount: fmt.Sprintf("%.2f", v), Currency: "CNY"}
}

func dispatchJoin(m Mutation, fetch Fetch) (json.RawMessage, *contract.Fail, bool) {
	var body struct {
		ActionID int64      `json:"action_id"`
		Items    []joinItem `json:"items"`
	}
	_ = json.Unmarshal(m.Raw, &body)
	type product struct {
		ProductID   int64  `json:"product_id"`
		ActionPrice money  `json:"action_price"`
		Stock       *int64 `json:"stock,omitempty"`
	}
	var products []product
	for _, it := range body.Items {
		row := product{ProductID: it.ProductID, ActionPrice: moneyText(it.ActionPrice)}
		if it.Stock != 0 {
			n := int64(it.Stock)
			row.Stock = &n
		}
		products = append(products, row)
	}
	raw, _ := compact(struct {
		ActionID int64     `json:"action_id"`
		Products []product `json:"products"`
	}{ActionID: body.ActionID, Products: products})
	page := fetch("POST", "/v1/actions/products/update", raw)
	return settledItems(m, page, "/v1/actions/products/update", func() []itemResult {
		return joinResults(body.Items, page.Body)
	})
}

func joinResults(items []joinItem, body string) []itemResult {
	out := make([]itemResult, 0, len(items))
	low := body
	for _, it := range items {
		msg := ""
		ok := true
		switch {
		case strings.Contains(low, "移出") || strings.Contains(strings.ToLower(low), "deactivated"):
			ok = false
			msg = "活动价超过该商品上限，Ozon 将其移出了活动"
		case strings.Contains(strings.ToLower(low), "rejected"):
			ok = false
			msg = MessageZH(jsonMessage(body))
		case strings.Contains(low, "不会产生变更") || strings.Contains(strings.ToLower(low), "missing"):
			ok = false
			msg = "Ozon 未接受该商品加入活动；若活动价与当前一致则不会产生变更"
		}
		out = append(out, itemResult{Identity: strconv.FormatInt(it.ProductID, 10), Succeeded: ok, Message: msg})
	}
	return out
}

func dispatchLeave(m Mutation, fetch Fetch) (json.RawMessage, *contract.Fail, bool) {
	body, _ := parseLeave(m.Raw)
	label := strings.TrimSpace(body.ActionType)
	if label == "" {
		label = "未知"
	}
	switch body.ActionType {
	case "PROMOCODE":
		ids := make([]string, len(body.ProductIDs))
		for i, id := range body.ProductIDs {
			ids[i] = strconv.FormatInt(id, 10)
		}
		raw, _ := compact(struct {
			ActionID   int64    `json:"action_id"`
			ProductIDs []string `json:"product_ids"`
		}{ActionID: body.ActionID, ProductIDs: ids})
		page := fetch("POST", "/v2/actions/products/deactivate", raw)
		return settledItems(m, page, "/v2/actions/products/deactivate", func() []itemResult {
			out := make([]itemResult, 0, len(body.ProductIDs))
			for _, id := range body.ProductIDs {
				out = append(out, itemResult{Identity: strconv.FormatInt(id, 10), Succeeded: true})
			}
			return out
		})
	case "ELASTIC_BOOSTING", "STOCK_DISCOUNT":
		exits := map[int64]float64{}
		for _, ex := range body.ExitPrices {
			exits[ex.ProductID] = ex.ExitPrice
		}
		out := make([]itemResult, 0, len(body.ProductIDs))
		type product struct {
			ProductID   int64 `json:"product_id"`
			ActionPrice money `json:"action_price"`
		}
		var products []product
		for _, id := range body.ProductIDs {
			price, ok := exits[id]
			if !ok {
				out = append(out, itemResult{Identity: strconv.FormatInt(id, 10), Succeeded: false, Message: "缺少该商品的退出价，未执行退出"})
				continue
			}
			products = append(products, product{ProductID: id, ActionPrice: moneyText(price)})
		}
		if len(products) == 0 {
			return viewOf(m.OperationID, out), nil, false
		}
		raw, _ := compact(struct {
			ActionID int64     `json:"action_id"`
			Products []product `json:"products"`
		}{ActionID: body.ActionID, Products: products})
		page := fetch("POST", "/v1/actions/products/update", raw)
		view, fail, unknown := settledItems(m, page, "/v1/actions/products/update", func() []itemResult {
			for _, p := range products {
				msg := ""
				ok := true
				if strings.Contains(page.Body, "仍以该价") || strings.Contains(strings.ToLower(page.Body), "active") {
					ok = false
					msg = "退出价未超过该商品上限，商品仍以该价留在活动中"
				}
				if w := jsonMessage(page.Body); w != "" && strings.Contains(strings.ToLower(page.Body), "warning") {
					ok = false
					msg = "Ozon 未移出该商品：" + w
				}
				out = append(out, itemResult{Identity: strconv.FormatInt(p.ProductID, 10), Succeeded: ok, Message: msg})
			}
			return out
		})
		return view, fail, unknown
	default:
		out := make([]itemResult, 0, len(body.ProductIDs))
		msg := "该活动类型（" + label + "）不支持在系统内退出，请到 Ozon 卖家后台操作"
		for _, id := range body.ProductIDs {
			out = append(out, itemResult{Identity: strconv.FormatInt(id, 10), Succeeded: false, Message: msg})
		}
		return viewOf(m.OperationID, out), nil, false
	}
}

func settledItems(m Mutation, page Page, path string, build func() []itemResult) (json.RawMessage, *contract.Fail, bool) {
	if undecided(page) {
		return nil, writeUnknown(m.OperationID, page, path), true
	}
	if f := decided(page, path); f != nil {
		return nil, f, false
	}
	return viewOf(m.OperationID, build()), nil, false
}

func undecided(page Page) bool {
	if page.Err != nil && page.Status == 0 {
		return true
	}
	if page.Status == 429 || page.Status >= 500 || page.Status == 0 {
		return true
	}
	return false
}

func decided(page Page, path string) *contract.Fail {
	if page.Status >= 400 && page.Status <= 499 && page.Status != 429 {
		return SellerHTTP(page.Status, page.Body, "提交 Ozon 商品操作", path, contract.CodeProducts)
	}
	return nil
}

func writeUnknown(operationID string, page Page, path string) *contract.Fail {
	msg := readMessage("提交 Ozon 商品操作", path, page.Status, page.Body, page.Err)
	return &contract.Fail{Status: 409, Code: contract.CodeSellerUnknown, Message: "Ozon 操作 " + strings.TrimSpace(operationID) + " 的结果未知：" + msg}
}

func SendUnknown(chatID string, page Page) *contract.Fail {
	msg := readMessage("发送 Ozon 聊天", "/v1/chat/send/message", page.Status, page.Body, page.Err)
	return &contract.Fail{Status: 409, Code: contract.CodeSellerUnknown, Message: "会话 " + chatID + " 的发送结果未知：" + msg}
}

// ChatSendRequest is the ledger body, not the HTTP body.
type ChatSendRequest struct {
	ChatID string `json:"chat_id"`
	Text   string `json:"text"`
}

func ValidateSend(chatID, text string) *contract.Fail {
	if strings.TrimSpace(chatID) == "" {
		return contract.Validation("会话身份无效")
	}
	if strings.TrimSpace(text) == "" {
		return contract.Validation("发送内容不能为空")
	}
	if len([]rune(text)) > 1000 {
		return contract.Validation("发送内容不能超过 1000 个字符")
	}
	return nil
}

func DecodeSend(raw []byte) (store, chat, text string, err error) {
	m, err := object(raw, "store_id", "chat_id", "text")
	if err != nil {
		return "", "", "", err
	}
	store, ok, err := rawString(m, "store_id")
	if err != nil || !ok {
		return "", "", "", errJSON
	}
	chat, ok, err = rawString(m, "chat_id")
	if err != nil || !ok {
		return "", "", "", errJSON
	}
	text, ok, err = rawString(m, "text")
	if err != nil || !ok {
		return "", "", "", errJSON
	}
	return store, chat, text, nil
}

func SendMessage(chatID, text string, fetch Fetch) (string, *contract.Fail, bool) {
	raw, _ := compact(map[string]string{"chat_id": strings.TrimSpace(chatID), "text": strings.TrimSpace(text)})
	page := fetch("POST", "/v1/chat/send/message", raw)
	if undecided(page) {
		return "", SendUnknown(strings.TrimSpace(chatID), page), true
	}
	if page.Status >= 400 && page.Status <= 499 {
		f := SellerHTTP(page.Status, page.Body, "发送 Ozon 聊天", "/v1/chat/send/message", contract.CodeMessage)
		return "", f, false
	}
	root := asObject(page.Body)
	return fieldString(root, "result"), nil, false
}
