package domain

import (
	"encoding/json"
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"

	"github.com/xxww0098/podhub-go/internal/platform/uuidx"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

const sellerNumberMax int64 = 9007199254740991

var priceAmount = regexp.MustCompile(`^(0|[1-9]\d{0,9})(\.\d{1,2})?$`)
var priceCurrency = regexp.MustCompile(`^[A-Z]{3}$`)

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
	ProductID    int64  `json:"product_id"`
	OfferID      string `json:"offer_id"`
	ActionPrice  string `json:"action_price"`
	CurrencyCode string `json:"currency_code"`
	Stock        *int64 `json:"stock"`
}

type joinBody struct {
	ActionID   int64      `json:"action_id"`
	ActionType string     `json:"action_type"`
	Items      []joinItem `json:"items"`
}

type exitPrice struct {
	ProductID    int64  `json:"product_id"`
	ExitPrice    string `json:"exit_price"`
	CurrencyCode string `json:"currency_code"`
}

type leaveBody struct {
	ActionID   int64       `json:"action_id"`
	ProductIDs []int64     `json:"product_ids"`
	ActionType string      `json:"action_type"`
	ExitPrices []exitPrice `json:"exit_prices"`
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
	if _, ok := uuidx.StrictUUID(m.OperationID); !ok {
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
	products := map[[2]int64]bool{}
	offers := map[string]bool{}
	for _, it := range body.Items {
		if strings.TrimSpace(it.OfferID) == "" || !sellerID(it.ProductID) || it.WarehouseID <= 0 || it.Stock < 0 {
			return contract.Validation("库存操作包含无效商品、仓库或负数库存")
		}
		product := [2]int64{it.ProductID, it.WarehouseID}
		offer := strings.TrimSpace(it.OfferID) + "\x00" + strconv.FormatInt(it.WarehouseID, 10)
		if products[product] || offers[offer] {
			return contract.Validation("每个商品仓库组合只能提交一次库存修改")
		}
		products[product], offers[offer] = true, true
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
	offers, products := map[string]bool{}, map[int64]bool{}
	for _, it := range body.Items {
		price, old := strings.TrimSpace(it.Price), strings.TrimSpace(it.OldPrice)
		if strings.TrimSpace(it.OfferID) == "" || !sellerID(it.ProductID) || !priceCurrency.MatchString(strings.TrimSpace(it.CurrencyCode)) || !priceAmount.MatchString(price) || !priceAmount.MatchString(old) {
			return contract.Validation("优惠操作包含无效商品、币种或价格")
		}
		p, _ := new(big.Rat).SetString(price)
		o, _ := new(big.Rat).SetString(old)
		if p.Sign() <= 0 || o.Sign() > 0 && o.Cmp(p) <= 0 || offers[strings.TrimSpace(it.OfferID)] || products[it.ProductID] {
			return contract.Validation("价格必须大于零、小于非零划线价，且每个商品只能提交一次")
		}
		offers[strings.TrimSpace(it.OfferID)], products[it.ProductID] = true, true
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
	var body joinBody
	if json.Unmarshal(raw, &body) != nil {
		return contract.Validation("加入活动的商品、价格、币种或库存格式无效")
	}
	if !sellerID(body.ActionID) || !promotionType(body.ActionType) {
		return contract.Validation("加入活动缺少有效的活动 ID 或不支持该活动类型")
	}
	if len(body.Items) == 0 || len(body.Items) > 100 {
		return contract.Validation("加入活动每次必须包含 1–100 个商品")
	}
	products, offers := map[int64]bool{}, map[string]bool{}
	for _, it := range body.Items {
		offer := strings.TrimSpace(it.OfferID)
		if offer == "" || !sellerID(it.ProductID) || !promotionMoney(it.ActionPrice, it.CurrencyCode) || it.Stock == nil || *it.Stock < 0 {
			return contract.Validation("加入活动包含无效商品、价格、币种或非整数库存")
		}
		if body.ActionType != "PROMOCODE" && *it.Stock != 0 {
			return contract.Validation("该活动类型不能设置活动库存")
		}
		if products[it.ProductID] || offers[offer] {
			return contract.Validation("加入活动每个商品只能提交一次")
		}
		products[it.ProductID], offers[offer] = true, true
	}
	return nil
}

func validateLeave(raw json.RawMessage) *contract.Fail {
	var body leaveBody
	if json.Unmarshal(raw, &body) != nil {
		return contract.Validation("退出活动的商品、退出价或币种格式无效")
	}
	if !sellerID(body.ActionID) || !promotionType(body.ActionType) {
		return contract.Validation("退出活动缺少有效的活动 ID 或不支持该活动类型")
	}
	if len(body.ProductIDs) == 0 || len(body.ProductIDs) > 100 {
		return contract.Validation("退出活动每次必须包含 1–100 个有效商品")
	}
	products := map[int64]bool{}
	for _, id := range body.ProductIDs {
		if !sellerID(id) || products[id] {
			return contract.Validation("退出活动每次必须包含 1–100 个不重复的有效商品")
		}
		products[id] = true
	}
	if body.ActionType == "PROMOCODE" {
		if len(body.ExitPrices) != 0 {
			return contract.Validation("优惠码活动退出不能提交退出价")
		}
		return nil
	}
	if len(body.ExitPrices) != len(body.ProductIDs) {
		return contract.Validation("退出活动必须为每个商品提交退出价和币种")
	}
	seen := map[int64]bool{}
	for _, ex := range body.ExitPrices {
		if !products[ex.ProductID] || seen[ex.ProductID] || !promotionMoney(ex.ExitPrice, ex.CurrencyCode) {
			return contract.Validation("退出价必须与商品一一对应，且包含有效价格和币种")
		}
		seen[ex.ProductID] = true
	}
	return nil
}

func promotionType(kind string) bool {
	return kind == "PROMOCODE" || kind == "ELASTIC_BOOSTING" || kind == "STOCK_DISCOUNT"
}

func promotionMoney(amount, currency string) bool {
	if !priceAmount.MatchString(amount) || !priceCurrency.MatchString(currency) {
		return false
	}
	value, _ := new(big.Rat).SetString(amount)
	return value.Sign() > 0
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
	items, ok := stockResults(body.Items, page.Body)
	if !ok {
		return nil, &contract.Fail{Status: 409, Code: contract.CodeSellerUnknown, Message: "Ozon 库存回执缺失或与商品仓库不匹配，请同步核对库存；不要重复提交"}, true
	}
	return viewOf(m.OperationID, items), nil, false
}

func stockResults(items []stockItem, body string) ([]itemResult, bool) {
	var reply struct {
		Result []struct {
			ProductID   int64  `json:"product_id"`
			OfferID     string `json:"offer_id"`
			WarehouseID int64  `json:"warehouse_id"`
			Updated     *bool  `json:"updated"`
			Errors      *[]struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"errors"`
		} `json:"result"`
	}
	if json.Unmarshal([]byte(body), &reply) != nil || len(reply.Result) != len(items) {
		return nil, false
	}
	requested := make(map[[2]int64]stockItem, len(items))
	for _, item := range items {
		requested[[2]int64{item.ProductID, item.WarehouseID}] = item
	}
	results := make(map[[2]int64]itemResult, len(items))
	for _, row := range reply.Result {
		key := [2]int64{row.ProductID, row.WarehouseID}
		item, matched := requested[key]
		if !matched || row.OfferID != strings.TrimSpace(item.OfferID) || row.Updated == nil || row.Errors == nil || *row.Updated && len(*row.Errors) != 0 {
			return nil, false
		}
		if _, duplicate := results[key]; duplicate {
			return nil, false
		}
		result := itemResult{Identity: fmt.Sprintf("%d/%d", row.ProductID, row.WarehouseID), Succeeded: *row.Updated}
		if !result.Succeeded {
			result.Message = "Ozon 未确认该商品仓库的库存更新"
			for _, issue := range *row.Errors {
				if message := localizeStock(issue.Code, issue.Message); message != "" {
					result.Message = message
					break
				}
			}
		}
		results[key] = result
	}
	out := make([]itemResult, 0, len(items))
	for _, item := range items {
		out = append(out, results[[2]int64{item.ProductID, item.WarehouseID}])
	}
	return out, true
}

func localizeStock(code, message string) string {
	low := strings.ToLower(code + " " + message)
	switch {
	case strings.Contains(low, "discount_for_average_price_is_too_small"):
		return "优惠率低于 Ozon 对当前价格区间的最低要求"
	case strings.Contains(low, "too_many_requests"):
		return "该商品在此仓库的库存改得太频繁，Ozon 暂时拒绝；请稍后重试"
	case strings.Contains(low, "archived_product") || strings.Contains(low, "archived product") || strings.Contains(low, "архив"):
		return "商品已归档，无法修改库存；请先确认是否需要恢复商品"
	default:
		if strings.TrimSpace(message) != "" {
			return MessageZH(message)
		}
		return MessageZH(code)
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
			"price": strings.TrimSpace(it.Price), "old_price": strings.TrimSpace(it.OldPrice), "currency_code": strings.TrimSpace(it.CurrencyCode),
		})
	}
	raw, _ := compact(map[string]any{"prices": prices})
	page := fetch("POST", "/v1/product/import/prices", raw)
	if undecided(page) {
		return nil, writeUnknown(m.OperationID, page, "/v1/product/import/prices"), true
	}
	if f := decided(page, "/v1/product/import/prices"); f != nil {
		return nil, f, false
	}
	items, ok := priceResults(body.Items, page.Body)
	if !ok {
		return nil, &contract.Fail{Status: 409, Code: contract.CodeSellerUnknown, Message: "Ozon 改价回执缺失或与商品不匹配，请同步核对价格；不要重复提交"}, true
	}
	return viewOf(m.OperationID, items), nil, false
}

func priceResults(items []priceItem, raw string) ([]itemResult, bool) {
	var reply struct {
		Result []struct {
			ProductID int64           `json:"product_id"`
			OfferID   string          `json:"offer_id"`
			Updated   *bool           `json:"updated"`
			Errors    json.RawMessage `json:"errors"`
		} `json:"result"`
	}
	if json.Unmarshal([]byte(raw), &reply) != nil || len(reply.Result) != len(items) {
		return nil, false
	}
	byOffer := make(map[string]itemResult, len(items))
	for _, row := range reply.Result {
		if row.Updated == nil || len(row.Errors) == 0 || row.Errors[0] != '[' {
			return nil, false
		}
		var issues []struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal(row.Errors, &issues) != nil {
			return nil, false
		}
		if *row.Updated && len(issues) != 0 {
			return nil, false
		}
		matched := false
		for _, item := range items {
			if row.OfferID == strings.TrimSpace(item.OfferID) && row.ProductID == item.ProductID {
				matched = true
				break
			}
		}
		if !matched {
			return nil, false
		}
		if _, duplicate := byOffer[row.OfferID]; duplicate {
			return nil, false
		}
		result := itemResult{Identity: row.OfferID, Succeeded: *row.Updated && len(issues) == 0}
		if !result.Succeeded {
			result.Message = "Ozon 未确认该商品的价格更新"
			for _, issue := range issues {
				if message := strings.TrimSpace(issue.Message); message != "" {
					result.Message = MessageZH(message)
					break
				}
			}
		}
		byOffer[row.OfferID] = result
	}
	out := make([]itemResult, 0, len(items))
	for _, item := range items {
		out = append(out, byOffer[strings.TrimSpace(item.OfferID)])
	}
	return out, true
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

type promotionProduct struct {
	ProductID   int64  `json:"product_id"`
	ActionPrice money  `json:"action_price"`
	Stock       *int64 `json:"stock,omitempty"`
}

func dispatchJoin(m Mutation, fetch Fetch) (json.RawMessage, *contract.Fail, bool) {
	if fail := validateJoin(m.Raw); fail != nil {
		return nil, fail, false
	}
	var body joinBody
	_ = json.Unmarshal(m.Raw, &body)
	products := make([]promotionProduct, 0, len(body.Items))
	ids := make([]int64, 0, len(body.Items))
	for _, it := range body.Items {
		row := promotionProduct{ProductID: it.ProductID, ActionPrice: money{Amount: it.ActionPrice, Currency: it.CurrencyCode}}
		if body.ActionType == "PROMOCODE" {
			row.Stock = it.Stock
		}
		products = append(products, row)
		ids = append(ids, it.ProductID)
	}
	return dispatchPromotionUpdate(m, body.ActionID, ids, products, true, fetch)
}

func dispatchLeave(m Mutation, fetch Fetch) (json.RawMessage, *contract.Fail, bool) {
	if fail := validateLeave(m.Raw); fail != nil {
		return nil, fail, false
	}
	var body leaveBody
	_ = json.Unmarshal(m.Raw, &body)
	if body.ActionType == "PROMOCODE" {
		ids := make([]string, len(body.ProductIDs))
		for i, id := range body.ProductIDs {
			ids[i] = strconv.FormatInt(id, 10)
		}
		raw, _ := compact(struct {
			ActionID   int64    `json:"action_id"`
			ProductIDs []string `json:"product_ids"`
		}{ActionID: body.ActionID, ProductIDs: ids})
		const path = "/v2/actions/products/deactivate"
		page := fetch("POST", path, raw)
		if fail, unknown := promotionPage(m.OperationID, page, path); fail != nil {
			return nil, fail, unknown
		}
		items, ok := promotionDeactivateResults(body.ProductIDs, page.Body)
		if !ok {
			return nil, promotionReceiptUnknown(), true
		}
		return viewOf(m.OperationID, items), nil, false
	}
	exits := make(map[int64]exitPrice, len(body.ExitPrices))
	for _, ex := range body.ExitPrices {
		exits[ex.ProductID] = ex
	}
	products := make([]promotionProduct, 0, len(body.ProductIDs))
	for _, id := range body.ProductIDs {
		ex := exits[id]
		products = append(products, promotionProduct{ProductID: id, ActionPrice: money{Amount: ex.ExitPrice, Currency: ex.CurrencyCode}})
	}
	return dispatchPromotionUpdate(m, body.ActionID, body.ProductIDs, products, false, fetch)
}

func dispatchPromotionUpdate(m Mutation, actionID int64, ids []int64, products []promotionProduct, joining bool, fetch Fetch) (json.RawMessage, *contract.Fail, bool) {
	raw, _ := compact(struct {
		ActionID int64              `json:"action_id"`
		Products []promotionProduct `json:"products"`
	}{ActionID: actionID, Products: products})
	const path = "/v1/actions/products/update"
	page := fetch("POST", path, raw)
	if fail, unknown := promotionPage(m.OperationID, page, path); fail != nil {
		return nil, fail, unknown
	}
	items, ok := promotionUpdateResults(ids, page.Body, joining)
	if !ok {
		return nil, promotionReceiptUnknown(), true
	}
	return viewOf(m.OperationID, items), nil, false
}

func promotionPage(operationID string, page Page, path string) (*contract.Fail, bool) {
	if undecided(page) {
		return writeUnknown(operationID, page, path), true
	}
	if fail := decided(page, path); fail != nil {
		return fail, false
	}
	if page.Status != 200 {
		return promotionReceiptUnknown(), true
	}
	return nil, false
}

func promotionReceiptUnknown() *contract.Fail {
	return &contract.Fail{Status: 409, Code: contract.CodeSellerUnknown, Message: "Ozon 活动回执缺失或与商品不匹配，请同步核对活动及商品卡片统一价格；不要重复提交"}
}

func promotionUpdateResults(ids []int64, raw string, joining bool) ([]itemResult, bool) {
	type issue struct {
		ProductID json.Number `json:"product_id"`
		Reason    string      `json:"reason"`
	}
	var reply struct {
		Active      *[]json.Number `json:"active_product_ids"`
		Deactivated *[]json.Number `json:"deactivated_product_ids"`
		Rejected    *[]issue       `json:"rejected"`
		Warnings    *[]issue       `json:"warnings"`
	}
	if json.Unmarshal([]byte(raw), &reply) != nil || reply.Active == nil || reply.Deactivated == nil || reply.Rejected == nil || reply.Warnings == nil {
		return nil, false
	}
	requested := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if !sellerID(id) || requested[id] {
			return nil, false
		}
		requested[id] = true
	}
	results := make(map[int64]itemResult, len(ids))
	deactivated := make(map[int64]bool, len(ids))
	record := func(rawID json.Number, state, reason string) bool {
		id, err := rawID.Int64()
		if err != nil || !requested[id] {
			return false
		}
		if _, duplicate := results[id]; duplicate {
			return false
		}
		result := itemResult{Identity: strconv.FormatInt(id, 10)}
		switch state {
		case "active":
			result.Succeeded = joining
			if !joining {
				result.Message = "Ozon 回执显示商品仍在活动中；请核对商品卡片统一价格"
			}
		case "deactivated":
			deactivated[id] = true
			result.Succeeded = !joining
			if joining {
				result.Message = "Ozon 已将该商品移出活动；请核对商品卡片统一价格"
			}
		case "rejected":
			result.Message = "Ozon 拒绝该商品更新"
			if message := MessageZH(reason); message != "" {
				result.Message += "：" + message
			}
		}
		results[id] = result
		return true
	}
	for _, id := range *reply.Active {
		if !record(id, "active", "") {
			return nil, false
		}
	}
	for _, id := range *reply.Deactivated {
		if !record(id, "deactivated", "") {
			return nil, false
		}
	}
	for _, row := range *reply.Rejected {
		if !record(row.ProductID, "rejected", row.Reason) {
			return nil, false
		}
	}
	warned := make(map[int64]bool, len(*reply.Warnings))
	for _, row := range *reply.Warnings {
		id, err := row.ProductID.Int64()
		if err != nil || !deactivated[id] || warned[id] {
			return nil, false
		}
		warned[id] = true
		if message := MessageZH(row.Reason); message != "" {
			result := results[id]
			if result.Message == "" {
				result.Message = "Ozon 已将该商品移出活动"
			}
			result.Message += "：" + message
			results[id] = result
		}
	}
	if len(results) != len(ids) {
		return nil, false
	}
	out := make([]itemResult, 0, len(ids))
	for _, id := range ids {
		out = append(out, results[id])
	}
	return out, true
}

func promotionDeactivateResults(ids []int64, raw string) ([]itemResult, bool) {
	var reply struct {
		ProductIDs *[]json.Number `json:"product_ids"`
	}
	if json.Unmarshal([]byte(raw), &reply) != nil || reply.ProductIDs == nil || len(*reply.ProductIDs) != len(ids) {
		return nil, false
	}
	requested := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if !sellerID(id) || requested[id] {
			return nil, false
		}
		requested[id] = true
	}
	seen := make(map[int64]bool, len(ids))
	for _, rawID := range *reply.ProductIDs {
		id, err := rawID.Int64()
		if err != nil || !requested[id] || seen[id] {
			return nil, false
		}
		seen[id] = true
	}
	out := make([]itemResult, 0, len(ids))
	for _, id := range ids {
		out = append(out, itemResult{Identity: strconv.FormatInt(id, 10), Succeeded: true})
	}
	return out, true
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
	return page.Err != nil || page.Status < 200 || page.Status >= 300 && page.Status < 400 || page.Status == 429 || page.Status >= 500
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

func DecodeSend(raw []byte) (operation, store, chat, text string, err error) {
	m, err := object(raw, "operation_id", "store_id", "chat_id", "text")
	if err != nil {
		return "", "", "", "", err
	}
	operation, ok, err := rawString(m, "operation_id")
	if err != nil || !ok {
		return "", "", "", "", errJSON
	}
	store, ok, err = rawString(m, "store_id")
	if err != nil || !ok {
		return "", "", "", "", errJSON
	}
	chat, ok, err = rawString(m, "chat_id")
	if err != nil || !ok {
		return "", "", "", "", errJSON
	}
	text, ok, err = rawString(m, "text")
	if err != nil || !ok {
		return "", "", "", "", errJSON
	}
	return operation, store, chat, text, nil
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
	result := strings.TrimSpace(fieldString(root, "result"))
	if result == "" {
		return "", &contract.Fail{Status: 409, Code: contract.CodeSellerUnknown, Message: "Ozon 消息回执缺失，请读取会话核对；不要重复发送"}, true
	}
	return result, nil, false
}
