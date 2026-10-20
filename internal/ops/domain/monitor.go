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
	productListPath  = "/v3/product/list"
	productInfoPath  = "/v3/product/info/list"
	pricesPath       = "/v5/product/info/prices"
	stocksPath       = "/v4/product/info/stocks"
	analyticsPath    = "/v1/analytics/data"
	pageLimit        = 1000
	maxProductPages  = 1000
	maxMetricsDays   = 30
	defaultDays      = 3
	analyticsMetrics = `["hits_view","session_view","ordered_units","revenue"]`
)

type MonitorRequest struct {
	StoreID        string
	OfferIDs       []string
	SKU            *int64
	IncludeMetrics bool
	MetricsDays    int64
	HasMetrics     bool
	HasDays        bool
}

type MetricsRequest struct {
	StoreID   string
	SKU       *int64
	Days      int64
	Dimension string
	HasDays   bool
}

func DecodeMonitor(raw []byte) (MonitorRequest, error) {
	m, err := object(raw, "store_id", "offer_ids", "sku", "include_metrics", "metrics_days")
	if err != nil {
		return MonitorRequest{}, err
	}
	store, ok, err := rawString(m, "store_id")
	if err != nil || !ok {
		return MonitorRequest{}, errJSON
	}
	req := MonitorRequest{StoreID: store, IncludeMetrics: true, MetricsDays: defaultDays}
	if rawIDs, ok := m["offer_ids"]; ok && string(rawIDs) != "null" {
		if json.Unmarshal(rawIDs, &req.OfferIDs) != nil {
			return MonitorRequest{}, errJSON
		}
	}
	sku, err := optI64(m, "sku")
	if err != nil {
		return MonitorRequest{}, err
	}
	req.SKU = sku
	if _, ok := m["include_metrics"]; ok {
		req.HasMetrics = true
		v, _, err := rawBool(m, "include_metrics")
		if err != nil {
			return MonitorRequest{}, err
		}
		req.IncludeMetrics = v
	}
	if _, ok := m["metrics_days"]; ok {
		req.HasDays = true
		v, present, err := rawI64(m, "metrics_days")
		if err != nil || !present {
			return MonitorRequest{}, errJSON
		}
		req.MetricsDays = v
	}
	return req, nil
}

func DecodeMetrics(raw []byte) (MetricsRequest, error) {
	m, err := object(raw, "store_id", "sku", "days", "dimension")
	if err != nil {
		return MetricsRequest{}, err
	}
	store, ok, err := rawString(m, "store_id")
	if err != nil || !ok {
		return MetricsRequest{}, errJSON
	}
	req := MetricsRequest{StoreID: store, Days: defaultDays, Dimension: "sku"}
	sku, err := optI64(m, "sku")
	if err != nil {
		return MetricsRequest{}, err
	}
	req.SKU = sku
	if _, ok := m["days"]; ok {
		req.HasDays = true
		v, present, err := rawI64(m, "days")
		if err != nil || !present {
			return MetricsRequest{}, errJSON
		}
		req.Days = v
	}
	if dim, ok, err := rawString(m, "dimension"); err != nil {
		return MetricsRequest{}, err
	} else if ok && strings.EqualFold(strings.TrimSpace(dim), "day") {
		req.Dimension = "day"
	}
	return req, nil
}

func ValidateSKU(sku *int64) *contract.Fail {
	if sku != nil && *sku <= 0 {
		return contract.Validation("SKU 必须是正整数，当前值为 " + strconv.FormatInt(*sku, 10))
	}
	return nil
}

func ValidateDays(days int64) *contract.Fail {
	if days < 1 || days > maxMetricsDays {
		return contract.Validation("经营指标同步天数必须在 1 到 30 之间，当前值为 " + strconv.FormatInt(days, 10))
	}
	return nil
}

func ValidateOffers(ids []string, sku *int64) ([]string, *contract.Fail) {
	if len(ids) == 0 {
		return nil, nil
	}
	if sku != nil {
		return nil, contract.Validation("货号筛选无效：SKU 与货号不能同时筛选")
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			return nil, contract.Validation("货号筛选无效：货号不能为空")
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	if len(out) > pageLimit {
		return nil, contract.Validation("货号筛选无效：一次最多查询 1000 个货号")
	}
	return out, nil
}

// ClassifyState is the official_state needle table. Archived wins.
func ClassifyState(archived bool, status string, hasInfo bool) string {
	if archived {
		return "archived"
	}
	if !hasInfo {
		return "missing"
	}
	if strings.TrimSpace(status) == "" {
		return "unknown"
	}
	hay := strings.ToLower(status)
	switch {
	case strings.Contains(hay, "снят") || strings.Contains(hay, "delist") || strings.Contains(hay, "disabled") || strings.Contains(hay, "rejected") || strings.Contains(hay, "failed"):
		return "delisted"
	case strings.Contains(hay, "модера") || strings.Contains(hay, "провер") || strings.Contains(hay, "готов к продаже") || strings.Contains(hay, "moder") || strings.Contains(hay, "pending") || strings.Contains(hay, "created") || strings.Contains(hay, "validation") || strings.Contains(hay, "обнов") || strings.Contains(hay, "updating"):
		return "moderating"
	case strings.Contains(hay, "не прода"):
		return "delisted"
	case strings.Contains(hay, "продается") || strings.Contains(hay, "в продаже") || strings.Contains(hay, "ready_for_sale") || strings.Contains(hay, "price_sent") || strings.Contains(hay, "active"):
		return "active"
	default:
		return "unknown"
	}
}

// ActionableError is false for Ozon's own marking auto-correction.
func ActionableError(code string) bool {
	return strings.ToLower(strings.TrimSpace(code)) != "marking_auto_corrected"
}

type monitorItem struct {
	ProductID                int64     `json:"product_id"`
	OfferID                  string    `json:"offer_id"`
	SKU                      int64     `json:"sku"`
	Name                     string    `json:"name"`
	CategoryName             string    `json:"category_name"`
	PrimaryImageURL          string    `json:"primary_image_url"`
	ImageCount               int64     `json:"image_count"`
	OfficialState            string    `json:"official_state"`
	StatusName               string    `json:"status_name"`
	IsArchived               bool      `json:"is_archived"`
	IssueCount               int64     `json:"issue_count"`
	IssueLevel               string    `json:"issue_level"`
	IssueCode                string    `json:"issue_code"`
	IssueMessage             string    `json:"issue_message"`
	Price                    float64   `json:"price"`
	OldPrice                 float64   `json:"old_price"`
	CurrencyCode             string    `json:"currency_code"`
	StockPresent             int64     `json:"stock_present"`
	StockReserved            int64     `json:"stock_reserved"`
	PromotionDiscountPercent float64   `json:"promotion_discount_percent"`
	PromotionActionTitle     string    `json:"promotion_action_title"`
	PromotionActionPrice     float64   `json:"promotion_action_price"`
	HitsView                 float64   `json:"hits_view"`
	SessionView              float64   `json:"session_view"`
	OrderedUnits             float64   `json:"ordered_units"`
	Revenue                  float64   `json:"revenue"`
	SessionViewSeries        []float64 `json:"session_view_series"`
}

type syncState struct {
	Domain             string `json:"domain"`
	LastSyncAtMS       int64  `json:"last_sync_at_ms"`
	LastError          string `json:"last_error"`
	RateLimitedUntilMS int64  `json:"rate_limited_until_ms"`
}

type performance struct {
	PeriodDays   int64   `json:"period_days"`
	HitsView     float64 `json:"hits_view"`
	SessionView  float64 `json:"session_view"`
	OrderedUnits float64 `json:"ordered_units"`
	Revenue      float64 `json:"revenue"`
	ThroughDay   string  `json:"through_day"`
}

type rosterItem struct {
	ProductID int64
	OfferID   string
	Archived  bool
}

// SyncProducts projects a monitor snapshot. pageLimit 0 uses the production 1000.
func SyncProducts(now time.Time, req MonitorRequest, offers []string, fetch Fetch, analyticsLimit int) (json.RawMessage, *contract.Fail) {
	if analyticsLimit <= 0 {
		analyticsLimit = pageLimit
	}
	nowMS := now.UnixMilli()
	states := map[string]*syncState{
		"products": {Domain: "products"},
		"prices":   {Domain: "prices"},
		"stocks":   {Domain: "stocks"},
		"metrics":  {Domain: "metrics"},
	}
	var items []monitorItem
	var errFail *contract.Fail
	if len(offers) > 0 {
		rows, f := infoByOffers(offers, fetch)
		if f != nil {
			return nil, f
		}
		states["products"].LastSyncAtMS = nowMS
		for _, row := range rows {
			items = append(items, projectInfo(row, false, nil, nil))
		}
	} else {
		roster, f := loadRoster(fetch)
		if f != nil {
			return nil, f
		}
		if len(roster) == 0 {
			roster, f = loadRoster(fetch)
			if f != nil {
				return nil, f
			}
		}
		infos, f := infoByIDs(productIDs(roster), fetch)
		if f != nil {
			return nil, f
		}
		states["products"].LastSyncAtMS = nowMS
		prices, pf := loadPrices(fetch)
		notePartial(states["prices"], pf, nowMS)
		stocks, sf := loadStocks(fetch)
		notePartial(states["stocks"], sf, nowMS)
		for _, r := range roster {
			info := infos[r.ProductID]
			var pricePtr *priceRow
			if p, ok := prices[r.ProductID]; ok {
				pricePtr = &p
			}
			var stockPtr *stockRow
			if st, ok := stocks[r.ProductID]; ok {
				stockPtr = &st
			}
			items = append(items, projectInfo(info, r.Archived, pricePtr, stockPtr))
			if items[len(items)-1].OfferID == "" {
				items[len(items)-1].OfferID = r.OfferID
			}
			if items[len(items)-1].ProductID == 0 {
				items[len(items)-1].ProductID = r.ProductID
			}
			items[len(items)-1].IsArchived = r.Archived
			items[len(items)-1].OfficialState = ClassifyState(r.Archived, items[len(items)-1].StatusName+" "+items[len(items)-1].OfficialState, info != nil)
			if r.Archived {
				items[len(items)-1].OfficialState = "archived"
			}
		}
		if req.IncludeMetrics {
			perf, bySKU, mf := readAnalytics(now, int(req.MetricsDays), req.SKU, false, analyticsLimit, fetch)
			notePartial(states["metrics"], mf, nowMS)
			if mf == "" {
				applyMetrics(items, bySKU, perf)
			}
			_ = perf
		}
	}
	if items == nil {
		items = []monitorItem{}
	}
	perf := performance{PeriodDays: req.MetricsDays, ThroughDay: now.UTC().Format("2006-01-02")}
	for _, it := range items {
		perf.HitsView += it.HitsView
		perf.SessionView += it.SessionView
		perf.OrderedUnits += it.OrderedUnits
		perf.Revenue += it.Revenue
	}
	if errFail != nil {
		return nil, errFail
	}
	return mustData(struct {
		StoreID     string        `json:"store_id"`
		Products    []monitorItem `json:"products"`
		SyncStates  []syncState   `json:"sync_states"`
		Performance performance   `json:"performance"`
	}{
		StoreID: strings.TrimSpace(req.StoreID), Products: items,
		SyncStates:  []syncState{*states["products"], *states["prices"], *states["stocks"], *states["metrics"]},
		Performance: perf,
	}), nil
}

func notePartial(st *syncState, msg string, nowMS int64) {
	if msg == "" {
		st.LastSyncAtMS = nowMS
		return
	}
	st.LastError = msg
	if strings.Contains(msg, "频繁") || strings.Contains(msg, "429") {
		st.RateLimitedUntilMS = nowMS + 60_000
	}
}

func productIDs(rows []rosterItem) []int64 {
	out := make([]int64, 0, len(rows))
	for _, r := range rows {
		if r.ProductID > 0 {
			out = append(out, r.ProductID)
		}
	}
	return out
}

func loadRoster(fetch Fetch) ([]rosterItem, *contract.Fail) {
	all, f := rosterPage(fetch, "ALL")
	if f != nil {
		return nil, f
	}
	arch, f := rosterPage(fetch, "ARCHIVED")
	if f != nil {
		return nil, f
	}
	seen := map[int64]struct{}{}
	var out []rosterItem
	for _, row := range all {
		seen[row.ProductID] = struct{}{}
		out = append(out, row)
	}
	for _, row := range arch {
		if _, ok := seen[row.ProductID]; ok {
			continue
		}
		row.Archived = true
		out = append(out, row)
	}
	return out, nil
}

func rosterPage(fetch Fetch, visibility string) ([]rosterItem, *contract.Fail) {
	var out []rosterItem
	var last string
	for page := 0; page < maxProductPages; page++ {
		body := map[string]any{"filter": map[string]any{"visibility": visibility}, "limit": pageLimit}
		if last != "" {
			body["last_id"] = last
		}
		raw, _ := compact(body)
		got := fetch("POST", productListPath, raw)
		if f := readPage(got, "读取商品数据", productListPath, contract.CodeProducts); f != nil {
			return nil, f
		}
		root := nested(asObject(got.Body), "result")
		rows := arr(root, "items")
		for _, row := range rows {
			out = append(out, rosterItem{ProductID: fieldI64(row, "product_id"), OfferID: fieldString(row, "offer_id"), Archived: fieldBool(row, "archived")})
		}
		last = strings.TrimSpace(fieldString(root, "last_id"))
		if len(rows) < pageLimit || last == "" {
			return out, nil
		}
	}
	return nil, &contract.Fail{Status: 502, Code: contract.CodeProducts, Message: "商品分页超过安全上限 1000000，已停止同步"}
}

func infoByOffers(offers []string, fetch Fetch) ([]map[string]json.RawMessage, *contract.Fail) {
	raw, _ := compact(map[string]any{"offer_id": offers})
	got := fetch("POST", productInfoPath, raw)
	if f := readPage(got, "读取商品数据", productInfoPath, contract.CodeProducts); f != nil {
		return nil, f
	}
	return arr(asObject(got.Body), "items"), nil
}

func infoByIDs(ids []int64, fetch Fetch) (map[int64]map[string]json.RawMessage, *contract.Fail) {
	out := map[int64]map[string]json.RawMessage{}
	if len(ids) == 0 {
		return out, nil
	}
	for i := 0; i < len(ids); i += pageLimit {
		end := i + pageLimit
		if end > len(ids) {
			end = len(ids)
		}
		chunk := make([]string, 0, end-i)
		for _, id := range ids[i:end] {
			chunk = append(chunk, strconv.FormatInt(id, 10))
		}
		raw, _ := compact(map[string]any{"product_id": chunk})
		got := fetch("POST", productInfoPath, raw)
		if f := readPage(got, "读取商品数据", productInfoPath, contract.CodeProducts); f != nil {
			return nil, f
		}
		for _, row := range arr(asObject(got.Body), "items") {
			out[fieldI64(row, "id")] = row
		}
	}
	return out, nil
}

type priceRow struct {
	Price, Marketing float64
	Currency, Title  string
}

func loadPrices(fetch Fetch) (map[int64]priceRow, string) {
	out := map[int64]priceRow{}
	var cursor string
	for page := 0; page < maxProductPages; page++ {
		body := map[string]any{"filter": map[string]any{"visibility": "ALL"}, "limit": pageLimit}
		if cursor != "" {
			body["cursor"] = cursor
		}
		raw, _ := compact(body)
		got := fetch("POST", pricesPath, raw)
		if f := readPage(got, "经营数据", pricesPath, contract.CodeProducts); f != nil {
			return out, f.Message
		}
		root := nested(asObject(got.Body), "result")
		rows := arr(root, "items")
		for _, row := range rows {
			price := nested(row, "price")
			actions := arr(nested(row, "marketing_actions"), "actions")
			title := ""
			if len(actions) > 0 {
				title = fieldString(actions[0], "title")
			}
			out[fieldI64(row, "product_id")] = priceRow{
				Price: fieldF64(price, "price"), Marketing: fieldF64(price, "marketing_seller_price"),
				Currency: fieldString(price, "currency_code"), Title: title,
			}
		}
		cursor = strings.TrimSpace(fieldString(root, "cursor"))
		if len(rows) < pageLimit || cursor == "" {
			break
		}
	}
	return out, ""
}

type stockRow struct{ Present, Reserved int64 }

func loadStocks(fetch Fetch) (map[int64]stockRow, string) {
	out := map[int64]stockRow{}
	var cursor string
	for page := 0; page < maxProductPages; page++ {
		body := map[string]any{"filter": map[string]any{"visibility": "ALL"}, "limit": pageLimit}
		if cursor != "" {
			body["cursor"] = cursor
		}
		raw, _ := compact(body)
		got := fetch("POST", stocksPath, raw)
		if f := readPage(got, "经营数据", stocksPath, contract.CodeProducts); f != nil {
			return out, f.Message
		}
		root := asObject(got.Body)
		rows := arr(root, "items")
		for _, row := range rows {
			var present, reserved int64
			for _, st := range arr(row, "stocks") {
				present += fieldI64(st, "present")
				reserved += fieldI64(st, "reserved")
			}
			out[fieldI64(row, "product_id")] = stockRow{Present: present, Reserved: reserved}
		}
		cursor = strings.TrimSpace(fieldString(root, "cursor"))
		if len(rows) < pageLimit || cursor == "" {
			break
		}
	}
	return out, ""
}

func projectInfo(info map[string]json.RawMessage, archived bool, price *priceRow, stock *stockRow) monitorItem {
	item := monitorItem{SessionViewSeries: []float64{}, IsArchived: archived}
	if info == nil {
		item.OfficialState = ClassifyState(archived, "", false)
		return item
	}
	item.ProductID = fieldI64(info, "id")
	item.OfferID = fieldString(info, "offer_id")
	item.SKU = fieldI64(info, "sku")
	item.Name = fieldString(info, "name")
	if cat := fieldI64(info, "description_category_id"); cat > 0 {
		item.CategoryName = "类目 " + strconv.FormatInt(cat, 10)
	}
	images := stringList(info, "images")
	primary := stringList(info, "primary_image")
	if len(primary) > 0 {
		item.PrimaryImageURL = primary[0]
	}
	seen := map[string]struct{}{}
	for _, u := range append(append([]string{}, images...), primary...) {
		if u == "" {
			continue
		}
		seen[u] = struct{}{}
	}
	item.ImageCount = int64(len(seen))
	status := nested(info, "statuses")
	statusName := fieldString(status, "status_name")
	statusCode := fieldString(status, "status")
	item.StatusName = statusName
	item.OfficialState = ClassifyState(archived, statusCode+" "+statusName, true)
	if stocks := arr(nested(info, "stocks"), "stocks"); len(stocks) > 0 && stock == nil {
		for _, st := range stocks {
			item.StockPresent += fieldI64(st, "present")
			item.StockReserved += fieldI64(st, "reserved")
		}
	}
	item.Price, _ = strconv.ParseFloat(fieldString(info, "price"), 64)
	item.CurrencyCode = fieldString(info, "currency_code")
	if price != nil {
		item.Price = price.Price
		item.CurrencyCode = price.Currency
		if price.Price > 0 && price.Marketing > 0 && price.Marketing < price.Price {
			item.PromotionDiscountPercent = (price.Price - price.Marketing) / price.Price * 100
			item.PromotionActionPrice = price.Marketing
			item.PromotionActionTitle = price.Title
			if item.PromotionActionTitle == "" {
				item.PromotionActionTitle = "卖家优惠"
			}
		}
	}
	if stock != nil {
		item.StockPresent = stock.Present
		item.StockReserved = stock.Reserved
	}
	return item
}

func stringList(m map[string]json.RawMessage, key string) []string {
	raw, ok := m[key]
	if !ok {
		return nil
	}
	var list []string
	if json.Unmarshal(raw, &list) == nil {
		return list
	}
	var one string
	if json.Unmarshal(raw, &one) == nil && one != "" {
		return []string{one}
	}
	return nil
}

type skuMetric struct {
	SKU                         int64
	Hits, Session, Ordered, Rev float64
}

func applyMetrics(items []monitorItem, bySKU map[int64]skuMetric, perf analyticsPerf) {
	for i := range items {
		m, ok := bySKU[items[i].SKU]
		if !ok {
			continue
		}
		items[i].HitsView = m.Hits
		items[i].SessionView = m.Session
		items[i].OrderedUnits = m.Ordered
		items[i].Revenue = m.Rev
	}
	_ = perf
}

type analyticsPerf struct {
	Hits, Session, Ordered, Revenue float64
	Through                         string
	Days                            []float64
	Items                           []skuMetric
	Err                             string
}

func readAnalytics(now time.Time, days int, sku *int64, day bool, limit int, fetch Fetch) (analyticsPerf, map[int64]skuMetric, string) {
	if days <= 0 {
		days = defaultDays
	}
	from, through := DayWindow(now, days)
	dim := "sku"
	sortKey := "sku"
	metrics := []string{"hits_view", "session_view", "ordered_units", "revenue"}
	if day {
		dim = "day"
		sortKey = "day"
	}
	var filters []map[string]string
	if sku != nil {
		filters = []map[string]string{{"key": "sku", "op": "EQ", "value": strconv.FormatInt(*sku, 10)}}
	}
	by := map[int64]skuMetric{}
	dayValue := map[string]float64{}
	var perf analyticsPerf
	perf.Through = through
	var firstTotals []float64
	offset := 0
	orderedIdx := 2
	for page := 0; page < maxProductPages; page++ {
		body := map[string]any{
			"date_from": from, "date_to": through,
			"dimension": []string{dim}, "metrics": metrics,
			"limit": limit, "offset": offset,
			"sort": []map[string]string{{"key": sortKey, "order": "ASC"}},
		}
		if len(filters) > 0 {
			body["filters"] = filters
		}
		raw, _ := compact(body)
		got := fetch("POST", analyticsPath, raw)
		if f := readPage(got, "经营数据", analyticsPath, contract.CodeProducts); f != nil {
			return perf, by, f.Message
		}
		root := nested(asObject(got.Body), "result")
		if root == nil {
			return perf, by, "经营指标响应无效：缺少 result"
		}
		if page == 0 {
			firstTotals = numList(root, "totals")
			if len(firstTotals) < len(metrics) {
				return perf, by, "经营指标响应无效：totals 指标少于请求项"
			}
			perf.Hits, perf.Session, perf.Ordered, perf.Revenue = firstTotals[0], firstTotals[1], firstTotals[2], firstTotals[3]
		}
		rows := arr(root, "data")
		if rows == nil && root["data"] == nil {
			return perf, by, "经营指标响应无效：缺少 data"
		}
		for _, row := range rows {
			dims := arr(row, "dimensions")
			if len(dims) != 1 {
				return perf, by, "经营指标响应无效：行 dimensions 必须恰好 1 项"
			}
			id := strings.TrimSpace(fieldString(dims[0], "id"))
			vals := numList(row, "metrics")
			if len(vals) < len(metrics) {
				return perf, by, "经营指标响应无效：行 metrics 指标少于请求项"
			}
			if day {
				dayValue[id] = vals[orderedIdx]
				continue
			}
			n, err := strconv.ParseInt(id, 10, 64)
			if err != nil || n <= 0 {
				return perf, by, "经营指标响应无效：SKU 维度无效：" + id
			}
			if _, ok := by[n]; ok {
				return perf, by, "经营指标响应无效：重复 SKU 维度 " + id
			}
			by[n] = skuMetric{SKU: n, Hits: vals[0], Session: vals[1], Ordered: vals[2], Rev: vals[3]}
		}
		if len(rows) < limit {
			break
		}
		offset += len(rows)
	}
	if day {
		filled, sum := fillDaySeries(now, days, dayValue)
		perf.Days = filled
		total := 0.0
		if len(firstTotals) > orderedIdx {
			total = firstTotals[orderedIdx]
		}
		if len(firstTotals) > orderedIdx && !near(sum, total) {
			return perf, by, "经营指标响应无效：日期出单合计 " + trimFloat(sum) + " 与总计 " + trimFloat(total) + " 不一致"
		}
	}
	return perf, by, ""
}

func fillDaySeries(now time.Time, days int, got map[string]float64) ([]float64, float64) {
	from, _ := DayWindow(now, days)
	start, err := time.Parse("2006-01-02", from)
	out := make([]float64, days)
	if err != nil {
		return out, 0
	}
	var sum float64
	for i := 0; i < days; i++ {
		key := start.AddDate(0, 0, i).Format("2006-01-02")
		out[i] = got[key]
		sum += out[i]
	}
	return out, sum
}

func numList(m map[string]json.RawMessage, key string) []float64 {
	raw, ok := m[key]
	if !ok {
		return nil
	}
	var nums []float64
	if json.Unmarshal(raw, &nums) == nil {
		return nums
	}
	return nil
}

func near(a, b float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d < 0.001
}

func trimFloat(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}

type metricsItem struct {
	SKU          int64   `json:"sku"`
	HitsView     float64 `json:"hits_view"`
	SessionView  float64 `json:"session_view"`
	OrderedUnits float64 `json:"ordered_units"`
	Revenue      float64 `json:"revenue"`
}

// SyncMetrics is the metrics route. limit 0 uses 1000. Tests pass 2.
func SyncMetrics(now time.Time, req MetricsRequest, fetch Fetch, limit int) (json.RawMessage, *contract.Fail) {
	if limit <= 0 {
		limit = pageLimit
	}
	day := req.Dimension == "day"
	perf, by, msg := readAnalytics(now, int(req.Days), req.SKU, day, limit, fetch)
	state := syncState{Domain: "metrics", LastSyncAtMS: now.UnixMilli()}
	if msg != "" {
		state.LastSyncAtMS = 0
		state.LastError = msg
	}
	items := make([]metricsItem, 0, len(by))
	if !day && msg == "" {
		for _, m := range by {
			items = append(items, metricsItem{SKU: m.SKU, HitsView: m.Hits, SessionView: m.Session, OrderedUnits: m.Ordered, Revenue: m.Rev})
		}
		sort.Slice(items, func(i, j int) bool { return items[i].SKU < items[j].SKU })
	}
	series := perf.Days
	if series == nil {
		series = []float64{}
	}
	return mustData(struct {
		StoreID     string        `json:"store_id"`
		Items       []metricsItem `json:"items"`
		SyncState   syncState     `json:"sync_state"`
		Performance performance   `json:"performance"`
		DaySeries   []float64     `json:"day_series"`
	}{
		StoreID: strings.TrimSpace(req.StoreID), Items: items, SyncState: state,
		Performance: performance{PeriodDays: req.Days, HitsView: perf.Hits, SessionView: perf.Session, OrderedUnits: perf.Ordered, Revenue: perf.Revenue, ThroughDay: perf.Through},
		DaySeries:   series,
	}), nil
}

// ConsoleOrdered reads 30 day totals of ordered_units only.
func ConsoleOrdered(now time.Time, fetch Fetch) (ordered float64, days []float64, through, fail string) {
	const daysN = 30
	from, through := DayWindow(now, daysN)
	body := map[string]any{
		"date_from": from, "date_to": through,
		"dimension": []string{"day"}, "metrics": []string{"ordered_units"},
		"limit": pageLimit, "offset": 0,
		"sort": []map[string]string{{"key": "day", "order": "ASC"}},
	}
	raw, _ := compact(body)
	got := fetch("POST", analyticsPath, raw)
	if f := readPage(got, "经营数据", analyticsPath, contract.CodeProducts); f != nil {
		return 0, nil, through, f.Message
	}
	root := nested(asObject(got.Body), "result")
	if root == nil {
		return 0, nil, through, "30 日出单快照不完整"
	}
	totals := numList(root, "totals")
	if len(totals) < 1 {
		return 0, nil, through, "30 日出单快照不完整"
	}
	values := map[string]float64{}
	for _, row := range arr(root, "data") {
		dims := arr(row, "dimensions")
		if len(dims) != 1 {
			return 0, nil, through, "30 日出单快照不完整"
		}
		vals := numList(row, "metrics")
		if len(vals) < 1 {
			return 0, nil, through, "30 日出单快照不完整"
		}
		values[fieldString(dims[0], "id")] = vals[0]
	}
	filled, sum := fillDaySeries(now, daysN, values)
	if !near(sum, totals[0]) || len(filled) != daysN {
		return 0, nil, through, "30 日出单快照不完整"
	}
	return totals[0], filled, through, ""
}
