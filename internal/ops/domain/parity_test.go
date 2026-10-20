package domain

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func okPage(body string) Page { return Page{Status: 200, Body: body} }

func TestApplyEdgesAndIllegalPairs(t *testing.T) {
	ok := []struct{ from, edge, to string }{
		{"dispatching", "settled", "settled"},
		{"dispatching", "result_unknown", "result_unknown"},
		{"result_unknown", "reconciled", "reconciled"},
		{"result_unknown", "conflict", "conflict"},
		{"result_unknown", "result_unknown", "result_unknown"},
	}
	for _, row := range ok {
		got, yes := Apply(row.from, row.edge)
		if !yes || got != row.to {
			t.Fatalf("%s -> %s = %s %v", row.from, row.edge, got, yes)
		}
	}
	for _, row := range [][2]string{
		{"dispatching", "reconciled"},
		{"dispatching", "conflict"},
		{"settled", "settled"},
		{"reconciled", "result_unknown"},
		{"", "settled"},
	} {
		if _, yes := Apply(row[0], row[1]); yes {
			t.Fatalf("illegal edge accepted %s -> %s", row[0], row[1])
		}
	}
}

func TestProbeBackoffAndLedgerSQL(t *testing.T) {
	got := []int{ProbeBackoff(0), ProbeBackoff(1), ProbeBackoff(2), ProbeBackoff(3), ProbeBackoff(4), ProbeBackoff(9)}
	want := []int{60, 120, 240, 480, 900, 900}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("backoff %v", got)
		}
	}
	if !strings.Contains(LedgerSQL, "ROW_NUMBER() OVER (ORDER BY updated_at DESC)") || !strings.Contains(LedgerSQL, "rn <= $2") {
		t.Fatal("ledger sql shape")
	}
	retained := strings.Split(LedgerSQL, "status NOT IN (")
	if len(retained) < 2 {
		t.Fatal("missing queue predicate")
	}
	for _, settled := range []string{"queued", "dispatching", "succeeded", "reconciled", "operator_attested"} {
		if !strings.Contains(retained[1], "'"+settled+"'") {
			t.Fatal(settled)
		}
	}
	for _, unresolved := range []string{"result_unknown", "failed", "conflict", "unknown"} {
		if strings.Contains(retained[1], "'"+unresolved+"'") {
			t.Fatal(unresolved)
		}
	}
}

func TestStatusFromWireAndRefreshDue(t *testing.T) {
	for raw, want := range map[string]string{
		"queued": "queued", "recorded": "queued", "dispatching": "dispatching",
		"succeeded": "succeeded", "failed": "failed", "result_unknown": "result_unknown",
		"reconciled": "reconciled", "conflict": "conflict", "operator_attested": "operator_attested",
		"something_else": "unknown", "": "unknown",
	} {
		if StatusFromWire(raw) != want {
			t.Fatalf("%s -> %s", raw, StatusFromWire(raw))
		}
	}
	now := int64(1_800_000_000_000)
	if !MetricsRefreshDue(nil, nil, now) {
		t.Fatal("missing row")
	}
	fresh := now - 59999
	if MetricsRefreshDue(&fresh, nil, now) {
		t.Fatal("still fresh")
	}
	stale := now - MetricsFreshMS
	if !MetricsRefreshDue(&stale, nil, now) {
		t.Fatal("exactly 60000 is due")
	}
	future := now + 1
	if MetricsRefreshDue(nil, &future, now) {
		t.Fatal("retry in the future")
	}
	if !MetricsRefreshDue(nil, &now, now) {
		t.Fatal("retry now")
	}
	if !Validated(ConsoleSnapshot{Ordered: 30, Days: make([]float64, 30), Through: "2026-08-24", SyncMS: 1}) {
		t.Fatal("complete snapshot")
	}
	if Validated(ConsoleSnapshot{Ordered: -1, Days: make([]float64, 30), Through: "2026-08-24", SyncMS: 1}) ||
		Validated(ConsoleSnapshot{Ordered: 30, Days: make([]float64, 29), Through: "2026-08-24", SyncMS: 1}) ||
		Validated(ConsoleSnapshot{Ordered: 30, Days: make([]float64, 30), Through: "  ", SyncMS: 1}) ||
		Validated(ConsoleSnapshot{Ordered: 30, Days: make([]float64, 30), Through: "2026-08-24", SyncMS: 0}) {
		t.Fatal("incomplete snapshot accepted")
	}
	neg := make([]float64, 30)
	neg[0] = -1
	if Validated(ConsoleSnapshot{Ordered: 30, Days: neg, Through: "2026-08-24", SyncMS: 1}) {
		t.Fatal("negative day")
	}
}

func TestDecideNeedsASecondIdenticalObservation(t *testing.T) {
	if Decide("applied", 0, nil, "gone").State != "reconciled" {
		t.Fatal("applied")
	}
	first := Decide("applied_by_absence", 0, nil, "gone")
	if first.State != "result_unknown" {
		t.Fatal(first)
	}
	again := Decide("applied_by_absence", 1, []byte(`"gone"`), "gone")
	if again.State != "reconciled" {
		t.Fatal(again)
	}
	conflict := Decide("contradicted", 1, []byte(`"diff"`), "diff")
	if conflict.State != "conflict" || conflict.Code != contract.ProbeConflict {
		t.Fatal(conflict)
	}
}

func TestShippingWindowAndProjection(t *testing.T) {
	now := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	var sent string
	view, fail := Shipping(now, ShippingRequest{StoreID: " store ", WindowDays: 7, Limit: 50}, func(method, path string, body []byte) Page {
		sent = string(body)
		if method != "POST" || path != "/v4/posting/fbs/unfulfilled/list" {
			t.Fatalf("%s %s", method, path)
		}
		return okPage(fixture(t, "ops_read__v4__posting__fbs__unfulfilled__list.json"))
	})
	if fail != nil {
		t.Fatal(fail.Message)
	}
	if !strings.Contains(sent, `"cutoff_from":"2026-08-10T12:00:00Z"`) || !strings.Contains(sent, `"cutoff_to":"2026-08-24T12:00:00Z"`) || !strings.Contains(sent, `"sort_dir":"ASC"`) {
		t.Fatal(sent)
	}
	var parsed struct {
		Data struct {
			StoreID  string `json:"store_id"`
			Postings []struct {
				PostingNumber string `json:"posting_number"`
				Quantity      int64  `json:"quantity"`
				DeadlineState string `json:"deadline_state"`
				PackingState  string `json:"packing_state"`
				LabelState    string `json:"label_state"`
			} `json:"postings"`
		} `json:"data"`
	}
	if json.Unmarshal(view, &parsed) != nil || parsed.Data.StoreID != "store" || len(parsed.Data.Postings) != 1 {
		t.Fatalf("%s", view)
	}
	p := parsed.Data.Postings[0]
	if p.PostingNumber != "33920145-0032-1" || p.Quantity != 2 || p.PackingState != "unpacked" || p.LabelState != "label_not_ready" || p.DeadlineState != "deadline_overdue" {
		t.Fatalf("%+v", p)
	}
}

func TestSupplyOrdersProjectAndFailClosed(t *testing.T) {
	var calls []string
	fetch := func(list, get, bundle string) Fetch {
		return func(method, path string, body []byte) Page {
			calls = append(calls, path)
			switch {
			case strings.Contains(path, "/v3/supply-order/list"):
				return okPage(list)
			case strings.Contains(path, "/status/counter"):
				return okPage(fixture(t, "supply_tests__COUNTERS.json"))
			case strings.Contains(path, "/v3/supply-order/get"):
				return okPage(get)
			default:
				if strings.Contains(string(body), "bundle-a") {
					return okPage(bundle)
				}
				return okPage(fixture(t, "supply_tests__BUNDLE_B.json"))
			}
		}
	}
	states, fail := ListFilterStates(nil)
	if fail != nil || len(states) != 11 || states[0] != "DATA_FILLING" {
		t.Fatal(states, fail)
	}
	if _, fail = ListFilterStates([]string{" ORDER_STATE_NOPE "}); fail == nil || !strings.Contains(fail.Message, "未知供货单状态：ORDER_STATE_NOPE") {
		t.Fatal(fail)
	}
	calls = nil
	view, fail := SupplyOrders(SupplyListRequest{}, states, fetch(fixture(t, "supply_tests__LIST.json"), fixture(t, "supply_tests__GET.json"), fixture(t, "supply_tests__BUNDLE_A.json")))
	if fail != nil {
		t.Fatal(fail.Message)
	}
	var parsed struct {
		Data struct {
			HasMore bool `json:"has_more"`
			Orders  []struct {
				OrderID          string `json:"order_id"`
				State            string `json:"state"`
				TimeslotTimezone string `json:"timeslot_timezone"`
				ItemCount        int64  `json:"item_count"`
				SKUCount         int64  `json:"sku_count"`
			} `json:"orders"`
			StatusCounts []struct {
				State string `json:"state"`
				Count int32  `json:"count"`
			} `json:"status_counts"`
		} `json:"data"`
	}
	if json.Unmarshal(view, &parsed) != nil {
		t.Fatal(string(view))
	}
	if parsed.Data.HasMore || parsed.Data.Orders[0].OrderID != "9007199254740993" || parsed.Data.Orders[0].State != "IN_TRANSIT" || parsed.Data.Orders[0].TimeslotTimezone != "Europe/Moscow" || parsed.Data.Orders[0].ItemCount != 144 || parsed.Data.Orders[0].SKUCount != 2 {
		t.Fatalf("%+v", parsed.Data.Orders[0])
	}
	if parsed.Data.Orders[1].State != "READY_TO_SUPPLY" || parsed.Data.StatusCounts[0].State != "IN_TRANSIT" || parsed.Data.StatusCounts[0].Count != 4 {
		t.Fatalf("%s", view)
	}
	calls = nil
	if _, fail = SupplyOrders(SupplyListRequest{}, states, fetch(fixture(t, "supply_tests__EMPTY_LIST.json"), "", "")); fail != nil {
		t.Fatal(fail)
	}
	for _, path := range calls {
		if strings.Contains(path, "/get") {
			t.Fatal("empty page called get")
		}
	}
	calls = nil
	if _, fail = SupplyOrders(SupplyListRequest{}, states, fetch(fixture(t, "supply_tests__INVALID_LIST.json"), "", "")); fail == nil || !strings.Contains(fail.Message, "无效的供货单编号") {
		t.Fatal(fail)
	}
	for _, path := range calls {
		if strings.Contains(path, "/get") {
			t.Fatal("invalid ids called get")
		}
	}
	if _, fail = SupplyOrders(SupplyListRequest{}, states, fetch(fixture(t, "supply_tests__LIST.json"), fixture(t, "supply_tests__GET_ONE.json"), fixture(t, "supply_tests__BUNDLE_A.json"))); fail == nil || !strings.Contains(fail.Message, "未返回全部供货单详情") {
		t.Fatal(fail)
	}
	_, fail = SupplyOrders(SupplyListRequest{}, states, func(method, path string, body []byte) Page {
		if strings.Contains(path, "bundle") {
			return okPage(fixture(t, "supply_tests__BUNDLE_EMPTY_MORE.json"))
		}
		if strings.Contains(path, "/list") {
			return okPage(fixture(t, "supply_tests__LIST.json"))
		}
		if strings.Contains(path, "counter") {
			return okPage(fixture(t, "supply_tests__COUNTERS.json"))
		}
		return okPage(fixture(t, "supply_tests__GET.json"))
	})
	if fail != nil {
		t.Fatal(fail)
	}
	_, fail = SupplyOrders(SupplyListRequest{}, states, func(method, path string, body []byte) Page {
		if strings.Contains(path, "/list") {
			return Page{Status: 403, Body: fixture(t, "supply_tests__OZON_DENIED.json")}
		}
		return okPage(`{}`)
	})
	if fail == nil || fail.Code != contract.CodeOzonAuthFailed || strings.Contains(fail.Message, "请检查网络") || !strings.Contains(fail.Message, "Ozon 拒绝访问") {
		t.Fatalf("%+v", fail)
	}
}

func TestWarehouseStocksAggregateAndPageBound(t *testing.T) {
	view, fail := SupplyWarehouseStocks(func(method, path string, body []byte) Page {
		if method == "GET" {
			return okPage(fixture(t, "supply_tests__AVAILABLE.json"))
		}
		return okPage(fixture(t, "supply_tests__STOCKS.json"))
	})
	if fail != nil {
		t.Fatal(fail.Message)
	}
	var parsed struct {
		Data struct {
			Warehouses []struct {
				Name     string `json:"name"`
				Present  int64  `json:"present"`
				SKUCount int64  `json:"sku_count"`
			} `json:"warehouses"`
		} `json:"data"`
	}
	if json.Unmarshal(view, &parsed) != nil || parsed.Data.Warehouses[0].Name != "Хоругвино" || parsed.Data.Warehouses[0].Present != 12920 || parsed.Data.Warehouses[0].SKUCount != 2 {
		t.Fatalf("%s", view)
	}
	if len(parsed.Data.Warehouses) != 3 || parsed.Data.Warehouses[2].Present != 0 {
		t.Fatalf("%s", view)
	}
	n := 0
	_, fail = SupplyWarehouseStocks(func(method, path string, body []byte) Page {
		if method == "GET" {
			return okPage(`{"result":[{"warehouse":{"id":"1","name":"A"}}]}`)
		}
		n++
		if n <= 20 {
			return okPage(fullStockPage())
		}
		return okPage(`{"result":{"rows":[]}}`)
	})
	if fail != nil || n != 21 {
		t.Fatalf("n %d %v", n, fail)
	}
	n = 0
	_, fail = SupplyWarehouseStocks(func(method, path string, body []byte) Page {
		if method == "GET" {
			return okPage(`{"result":[]}`)
		}
		n++
		return okPage(fullStockPage())
	})
	if fail == nil || !strings.Contains(fail.Message, "超过 20000 行") {
		t.Fatal(fail)
	}
	_, fail = SupplyWarehouseStocks(func(method, path string, body []byte) Page {
		if method == "GET" {
			return Page{Status: 500, Body: `{"message":"no"}`}
		}
		t.Fatal("stocks after roster failure")
		return Page{}
	})
	if fail == nil || fail.Code != contract.CodeSupply {
		t.Fatal(fail)
	}
}

func fullStockPage() string {
	row := `{"sku":1,"free_to_sell_amount":1,"promised_amount":0,"reserved_amount":0,"warehouse_name":"A"}`
	rows := make([]string, stockPageLimit)
	for i := range rows {
		rows[i] = row
	}
	return `{"result":{"rows":[` + strings.Join(rows, ",") + `]}}`
}

func TestMonitorProjectionAndMetrics(t *testing.T) {
	if ValidateSKU(ptr(int64(0))) == nil || ValidateDays(0) == nil || ValidateDays(31) == nil || ValidateDays(3) != nil {
		t.Fatal("bounds")
	}
	if ClassifyState(true, "price_sent Продается", true) != "archived" || ClassifyState(false, "price_sent Продается", true) != "active" || ClassifyState(false, "", false) != "missing" {
		t.Fatal("classify")
	}
	if ActionableError("marking_auto_corrected") || !ActionableError("missing_required_attribute") {
		t.Fatal("actionable")
	}
	var calls []string
	fetch := func(method, path string, body []byte) Page {
		calls = append(calls, path+" "+string(body))
		switch {
		case strings.Contains(string(body), `"visibility":"ARCHIVED"`):
			return okPage(fixture(t, "monitor_roster_archived.json"))
		case path == "/v3/product/list":
			return okPage(fixture(t, "monitor_roster_all.json"))
		case path == "/v3/product/info/list":
			return okPage(fixture(t, "monitor_product_info.json"))
		case path == "/v5/product/info/prices":
			return okPage(fixture(t, "monitor_prices.json"))
		case path == "/v4/product/info/stocks":
			return okPage(fixture(t, "monitor_stocks.json"))
		default:
			return okPage(fixture(t, "monitor_analytics.json"))
		}
	}
	now := time.Date(2026, 8, 17, 0, 0, 0, 0, time.UTC)
	view, fail := SyncProducts(now, MonitorRequest{StoreID: "s", IncludeMetrics: true, MetricsDays: 3}, nil, fetch, 0)
	if fail != nil {
		t.Fatal(fail.Message)
	}
	var snap struct {
		Data struct {
			Products []struct {
				OfferID                  string  `json:"offer_id"`
				ImageCount               int64   `json:"image_count"`
				StockPresent             int64   `json:"stock_present"`
				StockReserved            int64   `json:"stock_reserved"`
				Revenue                  float64 `json:"revenue"`
				PromotionDiscountPercent float64 `json:"promotion_discount_percent"`
				IsArchived               bool    `json:"is_archived"`
			} `json:"products"`
			SyncStates []struct {
				Domain string `json:"domain"`
			} `json:"sync_states"`
			Performance struct {
				PeriodDays int64 `json:"period_days"`
			} `json:"performance"`
		} `json:"data"`
	}
	if json.Unmarshal(view, &snap) != nil || len(snap.Data.Products) != 2 || snap.Data.Products[0].ImageCount != 2 || snap.Data.Products[0].StockPresent != 7 || snap.Data.Products[0].StockReserved != 2 || snap.Data.Products[0].Revenue != 180 || snap.Data.Products[0].PromotionDiscountPercent != 10 || snap.Data.Performance.PeriodDays != 3 || !snap.Data.Products[1].IsArchived || snap.Data.Products[1].OfferID != "ART-42" || len(snap.Data.SyncStates) != 4 {
		t.Fatalf("%s", view)
	}
	calls = nil
	view, fail = SyncProducts(now, MonitorRequest{StoreID: "s", IncludeMetrics: false, MetricsDays: 3}, []string{"ART-41"}, fetch, 0)
	if fail != nil || len(calls) != 1 || !strings.Contains(calls[0], `/v3/product/info/list`) || !strings.Contains(calls[0], `"offer_id":["ART-41"]`) {
		t.Fatalf("%v %s", calls, view)
	}
	calls = nil
	view, fail = SyncProducts(now, MonitorRequest{StoreID: "s", IncludeMetrics: false, MetricsDays: 3}, []string{"MISSING"}, func(method, path string, body []byte) Page {
		calls = append(calls, path)
		return okPage(`{"items":[]}`)
	}, 0)
	if fail != nil || len(calls) != 1 || !strings.Contains(string(view), `"products":[]`) {
		t.Fatal(string(view), calls, fail)
	}
}

func TestMetricsPagingAndDaySeries(t *testing.T) {
	now := time.Date(2026, 8, 17, 0, 0, 0, 0, time.UTC)
	var calls []string
	pages := []string{
		`{"result":{"data":[{"dimensions":[{"id":"90001"}],"metrics":[1,1,1,10]},{"dimensions":[{"id":"90002"}],"metrics":[2,2,2,20]}],"totals":[100,50,10,1000]}}`,
		`{"result":{"data":[{"dimensions":[{"id":"90003"}],"metrics":[3,3,3,30]}],"totals":[0,0,0,0]}}`,
	}
	view, fail := SyncMetrics(now, MetricsRequest{StoreID: "s", Days: 3, Dimension: "sku"}, func(method, path string, body []byte) Page {
		calls = append(calls, string(body))
		bodyText := pages[0]
		if len(calls) > 1 {
			bodyText = pages[1]
		}
		return okPage(bodyText)
	}, 2)
	if fail != nil {
		t.Fatal(fail.Message)
	}
	if !strings.Contains(calls[0], `"sort":[{"key":"sku","order":"ASC"}]`) || !strings.Contains(calls[0], `"metrics":["hits_view","session_view","ordered_units","revenue"]`) || !strings.Contains(calls[1], `"offset":2`) {
		t.Fatal(calls)
	}
	var snap struct {
		Data struct {
			Items []struct {
				SKU int64 `json:"sku"`
			} `json:"items"`
			Performance struct {
				OrderedUnits float64 `json:"ordered_units"`
				Revenue      float64 `json:"revenue"`
			} `json:"performance"`
		} `json:"data"`
	}
	if json.Unmarshal(view, &snap) != nil || len(snap.Data.Items) != 3 || snap.Data.Performance.OrderedUnits != 10 || snap.Data.Performance.Revenue != 1000 {
		t.Fatalf("%s", view)
	}
	first := now.AddDate(0, 0, -13).Format("2006-01-02")
	dayBody := `{"result":{"data":[{"dimensions":[{"id":"` + first + `"}],"metrics":[0,0,7,0]}],"totals":[0,0,7,0]}}`
	view, fail = SyncMetrics(now, MetricsRequest{StoreID: "s", Days: 14, Dimension: "day", SKU: ptr(int64(90041))}, func(method, path string, body []byte) Page {
		if !strings.Contains(string(body), `"dimension":["day"]`) || !strings.Contains(string(body), `"sort":[{"key":"day","order":"ASC"}]`) || !strings.Contains(string(body), `"filters":[{"key":"sku","op":"EQ","value":"90041"}]`) {
			t.Fatal(string(body))
		}
		return okPage(dayBody)
	}, 1000)
	if fail != nil {
		t.Fatal(fail.Message)
	}
	var series struct {
		Data struct {
			Items     []any     `json:"items"`
			DaySeries []float64 `json:"day_series"`
		} `json:"data"`
	}
	if json.Unmarshal(view, &series) != nil || len(series.Data.DaySeries) != 14 || series.Data.DaySeries[0] != 7 || len(series.Data.Items) != 0 {
		t.Fatalf("%s", view)
	}
	for _, v := range series.Data.DaySeries[1:] {
		if v != 0 {
			t.Fatal(series.Data.DaySeries)
		}
	}
	first30 := now.AddDate(0, 0, -29).Format("2006-01-02")
	ordered, days, _, errText := ConsoleOrdered(now, func(method, path string, body []byte) Page {
		if !strings.Contains(string(body), `"metrics":["ordered_units"]`) || strings.Contains(string(body), "hits_view") {
			t.Fatal(string(body))
		}
		return okPage(`{"result":{"data":[{"dimensions":[{"id":"` + first30 + `"}],"metrics":[3]}],"totals":[3]}}`)
	})
	if errText != "" || ordered != 3 || len(days) != 30 || days[0] != 3 {
		t.Fatalf("%v %v %s", ordered, days, errText)
	}
	_, _, _, errText = ConsoleOrdered(now, func(method, path string, body []byte) Page {
		return okPage(`{"result":{"data":[],"totals":[1]}}`)
	})
	if errText != "30 日出单快照不完整" {
		t.Fatal(errText)
	}
}

func TestMutationValidationJoinAndLeave(t *testing.T) {
	op := "00000000-0000-4000-8000-000000000001"
	base := func(req string) Mutation {
		m, err := DecodeMutation([]byte(`{"operation_id":"` + op + `","store_id":"00000000-0000-4000-8000-0000000000a1","request":` + req + `}`))
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	if fail := ValidateMutation(base(`{"kind":"stock","items":[]}`)); fail == nil || !strings.Contains(fail.Message, "1–100") {
		t.Fatal(fail)
	}
	if fail := ValidateMutation(base(`{"kind":"nope"}`)); fail == nil || fail.Code != contract.CodeNotPorted {
		t.Fatal(fail)
	}
	join := base(`{"kind":"promotion_join","action_id":7,"items":[{"product_id":1,"offer_id":"a","action_price":55,"stock":0},{"product_id":2,"offer_id":"b","action_price":1499.5,"stock":3}]}`)
	if ValidateMutation(join) != nil {
		t.Fatal("join")
	}
	var sent string
	view, fail, unknown := Dispatch(join, func(method, path string, body []byte) Page {
		sent = string(body)
		return okPage(`{"result":[]}`)
	})
	want := `{"action_id":7,"products":[{"product_id":1,"action_price":{"amount":"55.00","currency":"CNY"}},{"product_id":2,"action_price":{"amount":"1499.50","currency":"CNY"},"stock":3}]}`
	if fail != nil || unknown || sent != want || !json.Valid(view) {
		t.Fatalf("sent %s fail %v unknown %v", sent, fail, unknown)
	}
	leave := base(`{"kind":"promotion_leave","action_id":7,"product_ids":[1,2],"action_type":"PROMOCODE"}`)
	_, fail, unknown = Dispatch(leave, func(method, path string, body []byte) Page {
		sent = string(body)
		return okPage(`{"result":true}`)
	})
	if fail != nil || unknown || sent != `{"action_id":7,"product_ids":["1","2"]}` {
		t.Fatalf("%s %v", sent, fail)
	}
	called := false
	plain := base(`{"kind":"promotion_leave","action_id":7,"product_ids":[1],"action_type":""}`)
	view, fail, unknown = Dispatch(plain, func(method, path string, body []byte) Page {
		called = true
		return okPage(`{}`)
	})
	if called || fail != nil || unknown || !strings.Contains(string(view), "该活动类型（未知）不支持") {
		t.Fatalf("called %v %s", called, view)
	}
	if fail := ValidateSend(" ", "x"); fail == nil || fail.Message != "会话身份无效" {
		t.Fatal(fail)
	}
	if fail := ValidateSend("c", " "); fail == nil || fail.Message != "发送内容不能为空" {
		t.Fatal(fail)
	}
	if fail := ValidateSend("c", strings.Repeat("字", 1001)); fail == nil || !strings.Contains(fail.Message, "1000") {
		t.Fatal(fail)
	}
}

func TestInboxKeepsRequestOrderAndCounts(t *testing.T) {
	rows := AggregateInbox([]StoreInbox{
		{StoreID: "a", Name: "A", Fetched: false, FailReason: "没有可用的店铺会话", Chats: []inboxChat{}},
		{StoreID: "b", Name: "B", Fetched: true, UnreadCount: 0, SessionCount: 0, Chats: []inboxChat{}},
		{StoreID: "c", Name: "C", Fetched: true, UnreadCount: 2, WaitingReply: true, SessionCount: 2, Chats: []inboxChat{{SessionKind: "platform"}, {SessionKind: "buyer"}}},
	})
	var parsed struct {
		Data struct {
			StoreCount                int64 `json:"store_count"`
			FailedStoreCount          int64 `json:"failed_store_count"`
			WaitingReplyCount         int64 `json:"waiting_reply_count"`
			PlatformNotificationCount int64 `json:"platform_notification_count"`
			Stores                    []struct {
				StoreID string `json:"store_id"`
			} `json:"stores"`
		} `json:"data"`
	}
	if json.Unmarshal(rows, &parsed) != nil || parsed.Data.StoreCount != 3 || parsed.Data.FailedStoreCount != 1 || parsed.Data.WaitingReplyCount != 2 || parsed.Data.PlatformNotificationCount != 1 || parsed.Data.Stores[0].StoreID != "a" {
		t.Fatalf("%s", rows)
	}
	if sessionKind("buyer_seller") != "buyer" || sessionKind("SELLER_SUPPORT") != "ticket" || sessionKind("other") != "platform" {
		t.Fatal("session kind")
	}
}

func TestVoicePremiumAndChatSort(t *testing.T) {
	view, fail := Reviews(CursorRequest{StoreID: "s"}, func(method, path string, body []byte) Page {
		return Page{Status: 403, Body: fixture(t, "voice_tests__PREMIUM.json")}
	})
	if fail != nil || !strings.Contains(string(view), `"kind":"premium_plus_required"`) {
		t.Fatalf("%s %v", view, fail)
	}
	view, fail = Chats(CursorRequest{StoreID: "s"}, func(method, path string, body []byte) Page {
		return okPage(fixture(t, "voice_tests__CHATS.json"))
	})
	if fail != nil {
		t.Fatal(fail.Message)
	}
	var parsed struct {
		Data struct {
			Kind  string `json:"kind"`
			Items []struct {
				ChatID      string `json:"chat_id"`
				UnreadCount int64  `json:"unread_count"`
			} `json:"items"`
		} `json:"data"`
	}
	if json.Unmarshal(view, &parsed) != nil || parsed.Data.Kind != "available" || len(parsed.Data.Items) < 2 {
		t.Fatalf("%s", view)
	}
	if parsed.Data.Items[0].UnreadCount < parsed.Data.Items[1].UnreadCount {
		t.Fatal("sort")
	}
}

func TestPromotionsEmptyBeforeAnyCall(t *testing.T) {
	if len(PositiveProducts([]int64{0, -1})) != 0 {
		t.Fatal("filter")
	}
	raw := EmptyPromotions()
	if !strings.Contains(string(raw), `"actions":[]`) || !strings.Contains(string(raw), `"offers":[]`) {
		t.Fatal(string(raw))
	}
}

func TestChatAndProductKeys(t *testing.T) {
	if ChatKey("s", "c", "hi") == ChatKey("s", "c", "hj") {
		t.Fatal("text changes the key")
	}
	if !strings.HasPrefix(ProductKey("s", "op"), "ozon.product-mutation:s:") {
		t.Fatal(ProductKey("s", "op"))
	}
	sum := RequestHash("s", []byte(`{"chat_id":"c","text":"hi"}`))
	if !strings.HasPrefix(sum, "sha256:") || len(sum) != len("sha256:")+64 {
		t.Fatal(sum)
	}
}

func ptr(n int64) *int64 { return &n }
