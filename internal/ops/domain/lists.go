package domain

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

const (
	shippingPath  = "/v4/posting/fbs/unfulfilled/list"
	returnsPath   = "/v1/returns/list"
	cancelPath    = "/v2/conditional-cancellation/list"
	reviewList    = "/v2/review/list"
	reviewCount   = "/v2/review/count"
	questionList  = "/v1/question/list"
	questionCount = "/v1/question/count"
	chatList      = "/v3/chat/list"
	chatHistory   = "/v3/chat/history"
	opShipping    = "读取 FBS 待发货单"
	opReturns     = "读取退货单"
	opCancel      = "读取取消申请"
)

type ShippingRequest struct {
	StoreID    string
	Status     string
	WindowDays int64
	Cursor     string
	Limit      int64
}

func DecodeShipping(raw []byte) (ShippingRequest, error) {
	m, err := object(raw, "store_id", "status", "window_days", "cursor", "limit")
	if err != nil {
		return ShippingRequest{}, err
	}
	store, ok, err := rawString(m, "store_id")
	if err != nil || !ok {
		return ShippingRequest{}, errJSON
	}
	status, _, err := rawString(m, "status")
	if err != nil {
		return ShippingRequest{}, err
	}
	days := int64(7)
	if v, ok, err := rawI64(m, "window_days"); err != nil {
		return ShippingRequest{}, err
	} else if ok {
		days = v
	}
	cur, err := optString(m, "cursor")
	if err != nil {
		return ShippingRequest{}, err
	}
	limit := int64(50)
	if v, ok, err := rawI64(m, "limit"); err != nil {
		return ShippingRequest{}, err
	} else if ok {
		limit = v
	}
	req := ShippingRequest{StoreID: store, Status: status, WindowDays: days, Limit: limit}
	if cur != nil {
		req.Cursor = *cur
	}
	return req, nil
}

func clamp(n, lo, hi int64) int64 {
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

type shippingPosting struct {
	PostingNumber string            `json:"posting_number"`
	InProcessAt   string            `json:"in_process_at"`
	ShipmentDate  string            `json:"shipment_date"`
	Status        string            `json:"status"`
	Substatus     string            `json:"substatus"`
	Products      []shippingProduct `json:"products"`
	Quantity      int64             `json:"quantity"`
	DeadlineState string            `json:"deadline_state"`
	PackingState  string            `json:"packing_state"`
	LabelState    string            `json:"label_state"`
}

type shippingProduct struct {
	SKU      int64  `json:"sku"`
	OfferID  string `json:"offer_id"`
	Name     string `json:"name"`
	Quantity int32  `json:"quantity"`
}

type shippingView struct {
	StoreID  string            `json:"store_id"`
	Postings []shippingPosting `json:"postings"`
	HasNext  bool              `json:"has_next"`
	Cursor   string            `json:"cursor"`
}

func Shipping(now time.Time, req ShippingRequest, fetch Fetch) (json.RawMessage, *contract.Fail) {
	days := clamp(req.WindowDays, 1, 180)
	limit := clamp(req.Limit, 1, 100)
	cursor := strings.TrimSpace(req.Cursor)
	body := map[string]any{
		"filter": map[string]any{
			"cutoff_from": rfc3339(now.Add(-time.Duration(days) * 24 * time.Hour)),
			"cutoff_to":   rfc3339(now.Add(time.Duration(days) * 24 * time.Hour)),
		},
		"limit":    limit,
		"sort_dir": "ASC",
	}
	if cursor != "" {
		body["cursor"] = cursor
	}
	status := strings.TrimSpace(req.Status)
	if status != "" {
		body["filter"].(map[string]any)["statuses"] = []string{status}
	}
	raw, err := compact(body)
	if err != nil {
		return nil, contract.Internal("")
	}
	page := fetch("POST", shippingPath, raw)
	if f := readPage(page, opShipping, shippingPath, contract.CodeShipping); f != nil {
		return nil, f
	}
	root := asObject(page.Body)
	rows := arr(root, "postings")
	out := make([]shippingPosting, 0, len(rows))
	for _, row := range rows {
		var qty int64
		products := arr(row, "products")
		ps := make([]shippingProduct, 0, len(products))
		for _, p := range products {
			q := int32(fieldI64(p, "quantity"))
			qty += int64(q)
			ps = append(ps, shippingProduct{SKU: fieldI64(p, "sku"), OfferID: fieldString(p, "offer_id"), Name: fieldString(p, "name"), Quantity: q})
		}
		st := fieldString(row, "status")
		out = append(out, shippingPosting{
			PostingNumber: fieldString(row, "posting_number"),
			InProcessAt:   fieldString(row, "in_process_at"),
			ShipmentDate:  fieldString(row, "shipment_date"),
			Status:        st,
			Substatus:     fieldString(row, "substatus"),
			Products:      ps,
			Quantity:      qty,
			DeadlineState: deadlineState(fieldString(row, "shipment_date"), now),
			PackingState:  packingState(st),
			LabelState:    labelState(st),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ShipmentDate != out[j].ShipmentDate {
			return out[i].ShipmentDate < out[j].ShipmentDate
		}
		return out[i].PostingNumber < out[j].PostingNumber
	})
	view := shippingView{StoreID: strings.TrimSpace(req.StoreID), Postings: out, HasNext: fieldBool(root, "has_next"), Cursor: fieldString(root, "cursor")}
	return mustData(view), nil
}

func rfc3339(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05Z")
}

func deadlineState(shipment string, now time.Time) string {
	shipment = strings.TrimSpace(shipment)
	if shipment == "" {
		return "deadline_unknown"
	}
	t, err := time.Parse(time.RFC3339, shipment)
	if err != nil {
		return "deadline_unknown"
	}
	if t.Before(now) {
		return "deadline_overdue"
	}
	if !t.After(now.Add(4 * time.Hour)) {
		return "deadline_approaching"
	}
	return "deadline_ok"
}

func packingState(status string) string {
	switch status {
	case "awaiting_packaging":
		return "unpacked"
	case "awaiting_deliver", "delivering", "delivered", "driver_pickup", "sent_by_seller":
		return "packed"
	case "cancelled", "not_accepted":
		return "failed"
	case "arbitration", "client_arbitration":
		return "result_unknown"
	default:
		return "unknown"
	}
}

func labelState(status string) string {
	switch status {
	case "awaiting_packaging":
		return "label_not_ready"
	case "awaiting_deliver":
		return "label_ready"
	case "cancelled", "not_accepted":
		return "skipped"
	default:
		return "label_unknown"
	}
}

func fieldBool(m map[string]json.RawMessage, key string) bool {
	raw, ok := m[key]
	if !ok {
		return false
	}
	var v bool
	_ = json.Unmarshal(raw, &v)
	return v
}

func readPage(page Page, operation, path, screen string) *contract.Fail {
	if page.Err != nil && page.Status == 0 {
		if f := Egress(page.Err, screen); f != nil && f.Code != "" && f.Message != "Seller 凭据无法通过校验" {
			return f
		}
		f := Transport(operation, path, page.Err)
		f.Code = screen
		return f
	}
	if page.Status < 200 || page.Status >= 300 {
		return SellerHTTP(page.Status, page.Body, operation, path, screen)
	}
	return nil
}

func mustData(v any) json.RawMessage {
	raw, err := compact(struct {
		Data any `json:"data"`
	}{Data: v})
	if err != nil {
		return []byte(`{"data":null}`)
	}
	return raw
}

type ReturnsRequest struct {
	StoreID          string
	PostingNumber    string
	VisualStatusName string
	ReturnSchema     string
	LastID           *string
}

func DecodeReturns(raw []byte) (ReturnsRequest, error) {
	m, err := object(raw, "store_id", "posting_number", "visual_status_name", "return_schema", "last_id")
	if err != nil {
		return ReturnsRequest{}, err
	}
	store, ok, err := rawString(m, "store_id")
	if err != nil || !ok {
		return ReturnsRequest{}, errJSON
	}
	posting, _, err := rawString(m, "posting_number")
	if err != nil {
		return ReturnsRequest{}, err
	}
	visual, _, err := rawString(m, "visual_status_name")
	if err != nil {
		return ReturnsRequest{}, err
	}
	schema, _, err := rawString(m, "return_schema")
	if err != nil {
		return ReturnsRequest{}, err
	}
	last, err := optString(m, "last_id")
	if err != nil {
		return ReturnsRequest{}, err
	}
	return ReturnsRequest{StoreID: store, PostingNumber: posting, VisualStatusName: visual, ReturnSchema: schema, LastID: last}, nil
}

func ValidateReturns(req ReturnsRequest) *contract.Fail {
	switch strings.TrimSpace(req.ReturnSchema) {
	case "", "FBO", "FBS":
	default:
		return contract.Validation("return_schema 仅支持 FBO、FBS 或空值")
	}
	if req.LastID != nil {
		if _, ok := PositiveI64(*req.LastID); !ok {
			return contract.Validation("last_id 必须是正整数")
		}
	}
	return nil
}

type returnRow struct {
	ID            string `json:"id"`
	PostingNumber string `json:"posting_number"`
	Reason        string `json:"reason"`
	Status        string `json:"status"`
	StatusLabel   string `json:"status_label"`
	Schema        string `json:"schema"`
	OccurredAt    string `json:"occurred_at"`
	ProductName   string `json:"product_name"`
	OfferID       string `json:"offer_id"`
	SKU           string `json:"sku"`
}

type returnsView struct {
	Items   []returnRow `json:"items"`
	HasNext bool        `json:"has_next"`
	LastID  string      `json:"last_id"`
}

func Returns(req ReturnsRequest, fetch Fetch) (json.RawMessage, *contract.Fail) {
	filter := map[string]any{}
	if s := strings.TrimSpace(req.PostingNumber); s != "" {
		filter["posting_numbers"] = []string{s}
	}
	if s := strings.TrimSpace(req.VisualStatusName); s != "" {
		filter["visual_status_name"] = s
	}
	if s := strings.TrimSpace(req.ReturnSchema); s != "" {
		filter["return_schema"] = s
	}
	body := map[string]any{"limit": 50}
	if len(filter) > 0 {
		body["filter"] = filter
	}
	if req.LastID != nil {
		n, _ := PositiveI64(*req.LastID)
		body["last_id"] = n
	}
	raw, _ := compact(body)
	page := fetch("POST", returnsPath, raw)
	if f := readPage(page, opReturns, returnsPath, contract.CodeReturns); f != nil {
		return nil, f
	}
	root := asObject(page.Body)
	rows := arr(root, "returns")
	items := make([]returnRow, 0, len(rows))
	for _, row := range rows {
		visual := nested(row, "visual")
		st := nested(visual, "status")
		product := nested(row, "product")
		logistic := nested(row, "logistic")
		sys := fieldString(st, "sys_name")
		label := strings.TrimSpace(fieldString(st, "display_name"))
		if label == "" {
			label = sys
		}
		occurred := firstNonEmpty(fieldString(visual, "change_moment"), fieldString(logistic, "return_date"), fieldString(logistic, "final_moment"), fieldString(logistic, "technical_return_moment"))
		items = append(items, returnRow{
			ID: fieldString(row, "id"), PostingNumber: fieldString(row, "posting_number"), Reason: fieldString(row, "return_reason_name"),
			Status: sys, StatusLabel: label, Schema: fieldString(row, "schema"), OccurredAt: occurred,
			ProductName: fieldString(product, "name"), OfferID: fieldString(product, "offer_id"), SKU: skuString(product),
		})
	}
	last := ""
	if len(items) > 0 {
		last = strings.TrimSpace(items[len(items)-1].ID)
	}
	hasNext := fieldBool(root, "has_next")
	if hasNext {
		if _, ok := PositiveI64(last); !ok {
			return nil, &contract.Fail{Status: 502, Code: contract.CodeReturns, Message: "Ozon 返回了不可用于下一页的退货游标"}
		}
	}
	return mustData(returnsView{Items: items, HasNext: hasNext, LastID: last}), nil
}

func skuString(m map[string]json.RawMessage) string {
	if m == nil {
		return ""
	}
	if s, ok, err := rawString(m, "sku"); err == nil && ok {
		return s
	}
	if n := fieldI64(m, "sku"); n != 0 {
		return strconv.FormatInt(n, 10)
	}
	return ""
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

type CancelRequest struct {
	StoreID       string
	PostingNumber string
	State         string
	Initiator     string
	LastID        *string
}

func DecodeCancel(raw []byte) (CancelRequest, error) {
	m, err := object(raw, "store_id", "posting_number", "state", "initiator", "last_id")
	if err != nil {
		return CancelRequest{}, err
	}
	store, ok, err := rawString(m, "store_id")
	if err != nil || !ok {
		return CancelRequest{}, errJSON
	}
	posting, _, err := rawString(m, "posting_number")
	if err != nil {
		return CancelRequest{}, err
	}
	state, _, err := rawString(m, "state")
	if err != nil {
		return CancelRequest{}, err
	}
	init, _, err := rawString(m, "initiator")
	if err != nil {
		return CancelRequest{}, err
	}
	last, err := optString(m, "last_id")
	if err != nil {
		return CancelRequest{}, err
	}
	return CancelRequest{StoreID: store, PostingNumber: posting, State: state, Initiator: init, LastID: last}, nil
}

func ValidateCancel(req CancelRequest) *contract.Fail {
	switch strings.TrimSpace(req.Initiator) {
	case "", "OZON", "SELLER", "CLIENT", "SYSTEM", "DELIVERY":
	default:
		return contract.Validation("initiator 仅支持 OZON、SELLER、CLIENT、SYSTEM、DELIVERY 或空值")
	}
	if req.LastID != nil {
		if _, ok := PositiveI64(*req.LastID); !ok {
			return contract.Validation("last_id 必须是正整数")
		}
	}
	return nil
}

type cancelRow struct {
	CancellationID string `json:"cancellation_id"`
	PostingNumber  string `json:"posting_number"`
	Reason         string `json:"reason"`
	Status         string `json:"status"`
	StatusLabel    string `json:"status_label"`
	Initiator      string `json:"initiator"`
	OccurredAt     string `json:"occurred_at"`
}

type cancelView struct {
	Items   []cancelRow `json:"items"`
	LastID  string      `json:"last_id"`
	Counter int64       `json:"counter"`
	HasNext bool        `json:"has_next"`
}

func Cancellations(req CancelRequest, fetch Fetch) (json.RawMessage, *contract.Fail) {
	filters := map[string]any{}
	if s := strings.TrimSpace(req.PostingNumber); s != "" {
		filters["posting_number"] = []string{s}
	}
	if s := strings.TrimSpace(req.State); s != "" {
		filters["state"] = s
	}
	if s := strings.TrimSpace(req.Initiator); s != "" {
		filters["cancellation_initiator"] = []string{s}
	}
	body := map[string]any{"limit": 50, "with": map[string]any{"counter": true}}
	if len(filters) > 0 {
		body["filters"] = filters
	}
	if req.LastID != nil {
		n, _ := PositiveI64(*req.LastID)
		body["last_id"] = n
	}
	raw, _ := compact(body)
	page := fetch("POST", cancelPath, raw)
	if f := readPage(page, opCancel, cancelPath, contract.CodeReturns); f != nil {
		return nil, f
	}
	root := asObject(page.Body)
	rows := arr(root, "result")
	items := make([]cancelRow, 0, len(rows))
	for _, row := range rows {
		reason := nested(row, "cancellation_reason")
		name := fieldString(reason, "name")
		msg := fieldString(row, "cancellation_reason_message")
		text := name
		if name == "" {
			text = msg
		} else if msg != "" && msg != name {
			text = name + " · " + msg
		}
		state := nested(row, "state")
		st := fieldString(state, "state")
		label := strings.TrimSpace(fieldString(state, "name"))
		if label == "" {
			label = st
		}
		id := ""
		if n := fieldI64(row, "cancellation_id"); n > 0 {
			id = strconv.FormatInt(n, 10)
		}
		items = append(items, cancelRow{
			CancellationID: id, PostingNumber: fieldString(row, "posting_number"), Reason: text,
			Status: st, StatusLabel: label, Initiator: fieldString(row, "cancellation_initiator"),
			OccurredAt: firstNonEmpty(fieldString(row, "cancelled_at"), fieldString(row, "approve_date"), fieldString(row, "auto_approve_date"), fieldString(row, "order_date")),
		})
	}
	lastNum := fieldI64(root, "last_id")
	last := ""
	if lastNum > 0 {
		last = strconv.FormatInt(lastNum, 10)
	}
	hasNext := len(rows) >= 50
	if hasNext && lastNum <= 0 {
		return nil, &contract.Fail{Status: 502, Code: contract.CodeReturns, Message: "Ozon 返回了不可用于下一页的取消申请游标"}
	}
	return mustData(cancelView{Items: items, LastID: last, Counter: fieldI64(root, "counter"), HasNext: hasNext}), nil
}
