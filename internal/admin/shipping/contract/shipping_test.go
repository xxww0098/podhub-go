package contract

import (
	"errors"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/egressgate"
)

func i64p(n int64) *int64 { return &n }

func basePayload() PresetPayload {
	p := PresetPayload{
		Mode: "aggregator", WarehouseName: "Москва rFBS", Phone: "+7(495)123-45-67",
		AddressCoordinates: Coordinates{Latitude: 55.75, Longitude: 37.61},
		CutIn:              60, WeightUnit: "g",
		CourierPhones: []string{"+7(495)123-45-67"},
	}
	p.fill()
	return p
}

func TestNormalizePayloadMessages(t *testing.T) {
	ok, err := NormalizePayload(basePayload())
	if err != nil || ok.Phone != "+7(495)123-45-67" || ok.WarehouseName != "Москва rFBS" {
		t.Fatalf("%+v %v", ok, err)
	}
	cases := []struct {
		name string
		mut  func(*PresetPayload)
		want string
	}{
		{"unpinned weights", func(p *PresetPayload) {
			p.WeightUnit = "unpinned"
			p.DeliveryCosts = &DeliveryCosts{MinWeight: i64p(1)}
		}, "未钉定重量单位时不能填写重量区间，请使用 g"},
		{"non integrated", func(p *PresetPayload) { p.Mode = "non_integrated" }, "非聚合模式必须填写 courierCutoff"},
		{"phone", func(p *PresetPayload) { p.Phone = "+74951234567" }, "仓库电话须为 +7(XXX)XXX-XX-XX"},
		{"cut", func(p *PresetPayload) { p.CutIn = 7 }, "cutIn 不是官方分钟枚举"},
		{"cutoff", func(p *PresetPayload) { p.CourierCutoff = i64p(6) }, "courierCutoff 不是官方分钟枚举"},
		{"phones", func(p *PresetPayload) {
			p.CourierPhones = []string{"+7(495)123-45-67", "+7(495)123-45-67", "+7(495)123-45-67", "+7(495)123-45-67"}
		}, "快递员电话最多 3 个"},
		{"negative", func(p *PresetPayload) { p.DeliveryCosts = &DeliveryCosts{MinWeight: i64p(-1)} }, "最低重量不能为负数"},
		{"kg", func(p *PresetPayload) {
			p.WeightUnit = "kg"
			p.DeliveryCosts = &DeliveryCosts{MinWeight: i64p(1 << 62)}
		}, "最低重量按千克换算克会溢出"},
		{"coords", func(p *PresetPayload) { p.AddressCoordinates.Latitude = 91 }, "仓库坐标无效"},
		{"warehouse", func(p *PresetPayload) { p.WarehouseName = "  " }, "仓库名称需为 1–100 个字符"},
	}
	for _, tc := range cases {
		p := basePayload()
		tc.mut(&p)
		_, err := NormalizePayload(p)
		if err == nil || err.Error() != tc.want || err.Code != "VALIDATION" || err.Status != 400 {
			t.Fatalf("%s got %v", tc.name, err)
		}
	}
}

func TestPrepareUpdateAndIDs(t *testing.T) {
	_, _, err := PrepareUpdate(0, "n", basePayload())
	if err == nil || err.Error() != "expectedCurrentVersion 无效" {
		t.Fatal(err)
	}
	_, _, err = PrepareCreate("  ", basePayload())
	if err == nil || err.Error() != "预设名称需为 1–100 个字符" {
		t.Fatal(err)
	}
	_, _, err = NormalizeIDs(" ", "p")
	if err == nil || err.Error() != "请选择平台 SKU 和物流预设" {
		t.Fatal(err)
	}
	_, err = NormalizeProduct("  ")
	if err == nil || err.Error() != "请选择平台商品" {
		t.Fatal(err)
	}
	raw := []byte(`{"name":"A","payload":{"mode":"aggregator","warehouseName":"W","phone":"+7(495)123-45-67","addressCoordinates":{"latitude":1,"longitude":2},"cutIn":15,"weightUnit":"g"},"extra":1}`)
	if _, _, err := DecodeCreate(raw); err == nil || err.Error() != "请求格式无效" {
		t.Fatal(err)
	}
}

func TestTransitionEdges(t *testing.T) {
	pass := []struct{ from, edge, to string }{
		{"queued", "reconcile_list_failed", "unknown"},
		{"succeeded", "reconcile_absent", "unknown"},
		{"unknown", "reconcile_active", "succeeded"},
		{"failed", "reconcile_method_waiting", "waiting"},
		{"waiting", "reconcile_no_method", "waiting"},
		{"unknown", "safe_continue", "submitting"},
		{"submitting", "create_accepted", "waiting"},
		{"submitting", "create_lost", "unknown"},
		{"submitting", "create_failed", "failed"},
	}
	for _, tc := range pass {
		got, ok := Transition(tc.from, tc.edge)
		if !ok || got != tc.to {
			t.Fatalf("%s %s -> %s %v", tc.from, tc.edge, got, ok)
		}
	}
	illegal := []struct{ from, edge string }{
		{"succeeded", "safe_continue"},
		{"failed", "safe_continue"},
		{"unknown", "create_accepted"},
		{"waiting", "create_failed"},
		{"queued", "create_lost"},
		{"unknown", "not_an_edge"},
		{"nope", "reconcile_active"},
	}
	for _, tc := range illegal {
		if _, ok := Transition(tc.from, tc.edge); ok {
			t.Fatalf("illegal %s %s passed", tc.from, tc.edge)
		}
	}
}

func TestSafeContinueBlock(t *testing.T) {
	now := int64(1_000_000)
	absent := now - 1000
	ok := SafeFact{Found: true, Mode: "aggregator", Status: "unknown", RemoteAbsentAtMs: &absent}
	if err := SafeContinueBlock(now, ok); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		f    SafeFact
		want string
	}{
		{SafeFact{Found: true, Mode: "non_integrated", Status: "unknown", RemoteAbsentAtMs: &absent}, "非聚合模式不支持一键注入"},
		{SafeFact{Mode: "aggregator"}, "没有注入事实"},
		{SafeFact{Found: true, Mode: "aggregator", Status: "failed", RemoteAbsentAtMs: &absent}, "须先重新核对并证明远端不存在"},
		{SafeFact{Found: true, Mode: "aggregator", Status: "unknown"}, "须先重新核对并证明远端不存在"},
	}
	for _, tc := range cases {
		err := SafeContinueBlock(now, tc.f)
		if err == nil || err.Error() != tc.want {
			t.Fatalf("%v %v", tc.want, err)
		}
	}
	old := now - absenceFreshMS - 1
	err := SafeContinueBlock(now, SafeFact{Found: true, Mode: "aggregator", Status: "unknown", RemoteAbsentAtMs: &old})
	if err == nil || err.Error() != "远端不存在证明已过期，请先重新核对" {
		t.Fatal(err)
	}
	edge := now - absenceFreshMS
	if err := SafeContinueBlock(now, SafeFact{Found: true, Mode: "aggregator", Status: "unknown", RemoteAbsentAtMs: &edge}); err != nil {
		t.Fatal(err)
	}
}

func TestReadiness(t *testing.T) {
	none := EvaluateReadiness("sku", nil, "", nil, nil)
	if none.Status != "blocked" || none.InjectReady || len(none.Reasons) != 1 || none.Reasons[0] != "missing_bind" || none.PresetID != nil {
		t.Fatalf("%+v", none)
	}
	bind := &BindingRef{PresetID: "shp", RequiredVersion: 1}
	nostore := EvaluateReadiness("sku", bind, "  ", nil, nil)
	if nostore.Reasons[0] != "inject_not_available" || nostore.InjectReady || *nostore.RequiredVersion != 1 {
		t.Fatalf("%+v", nostore)
	}
	payload := basePayload()
	payload.Mode = "non_integrated"
	payload.WeightUnit = "unpinned"
	payload.DeliveryCosts = &DeliveryCosts{MaxWeight: i64p(2)}
	blocked := EvaluateReadiness("sku", bind, "store", &payload, nil)
	if strings.Join(blocked.Reasons, ",") != "non_integrated_unsupported,weight_unit_unpinned,shop_not_injected" || blocked.Status != "blocked" {
		t.Fatalf("%+v", blocked)
	}
	wh, dm := int64(9), int64(10)
	active := "ACTIVE"
	base := basePayload()
	ready := EvaluateReadiness("sku", bind, "store", &base, &InjectionFact{
		PinnedVersion: 1, Status: "succeeded", WarehouseID: &wh, DeliveryMethodID: &dm, DeliveryMethodStatus: &active,
	})
	if ready.Status != "ready" || !ready.InjectReady || len(ready.Reasons) != 0 {
		t.Fatalf("%+v", ready)
	}
	stale := EvaluateReadiness("sku", bind, "store", nil, &InjectionFact{
		PinnedVersion: 2, Status: "succeeded", WarehouseID: &wh, DeliveryMethodID: &dm, DeliveryMethodStatus: &active,
	})
	if stale.Status != "stale" || stale.InjectReady || stale.Reasons[0] != "stale_version" {
		t.Fatalf("%+v", stale)
	}
	waiting := EvaluateReadiness("sku", bind, "store", nil, &InjectionFact{PinnedVersion: 1, Status: "queued"})
	if waiting.Status != "blocked" || waiting.Reasons[0] != "waiting" {
		t.Fatalf("%+v", waiting)
	}
}

func TestPickAndSafeError(t *testing.T) {
	known := int64(7)
	methods := []ListedMethod{{ID: 7, WarehouseID: 1, Name: "other", Status: "NEW", IsExpress: false}}
	got := PickMethod(nil, 1, &known, methods)
	if got == nil || got.ID != 7 {
		t.Fatal(got)
	}
	status, _, ms := VerifyOutcome(got, "waiting")
	if status != "waiting" || ms == nil || *ms != "NEW" {
		t.Fatalf("%s %v", status, ms)
	}
	active := ListedMethod{ID: 3, WarehouseID: 1, Name: "Express", Status: "active", IsExpress: true}
	status, _, _ = VerifyOutcome(&active, "waiting")
	if status != "succeeded" {
		t.Fatal(status)
	}
	if s, _, _ := VerifyOutcome(nil, "waiting"); s != "waiting" {
		t.Fatal(s)
	}
	absent := int64(5)
	view := InjectionView(Diagnostic{Status: "unknown", RemoteAbsentAtMs: &absent, StoreUUID: "s", PresetID: "p"}, 10)
	if !view.CanReconcile || !view.CanSafeContinue || view.SafeError == nil || *view.SafeError != "远端未找到同名仓库，可安全继续" {
		t.Fatalf("%+v", view)
	}
	unknown := InjectionView(Diagnostic{Status: "unknown"}, 10)
	if unknown.CanSafeContinue || *unknown.SafeError != "结果未知，尚未证明远端不存在" {
		t.Fatalf("%+v", unknown)
	}
	failed := InjectionView(Diagnostic{Status: "failed"}, 10)
	if *failed.SafeError != "注入已失败" || failed.InjectStatus != "failed" {
		t.Fatalf("%+v", failed)
	}
	since := int64(3)
	wait := InjectionView(Diagnostic{Status: "waiting", WaitingSinceMs: &since}, 10)
	if wait.WaitingDurationMs == nil || *wait.WaitingDurationMs != 7 || wait.SafeError != nil {
		t.Fatalf("%+v", wait)
	}
}

func TestWriteGates(t *testing.T) {
	if err := InjectWritesClosed(false); err == nil || err.Error() != "物流注入写入未启用" || err.Code != "WRITES_DISABLED" || err.Status != 503 {
		t.Fatal(err)
	}
	if InjectWritesClosed(true) != nil {
		t.Fatal("enabled")
	}
	err := SellerWritesClosed(true)
	if err == nil || err.Code != "WRITES_DISABLED" || err.Status != 503 || !errors.Is(egressgate.ErrWritesDisabled, egressgate.ErrWritesDisabled) || err.Error() != egressgate.ErrWritesDisabled.Error() {
		t.Fatal(err)
	}
	if SellerWritesClosed(false) != nil {
		t.Fatal("open")
	}
}

func TestStoredPayloadFallback(t *testing.T) {
	p := DecodeStoredPayload([]byte(`{"nope":1}`))
	if p.Mode != "aggregator" || p.Phone != "+7(000)000-00-00" || p.CutIn != 15 || p.WeightUnit != "g" {
		t.Fatalf("%+v", p)
	}
}

func TestShippingRulesMatchLegacy(t *testing.T) {
	methods := []ListedMethod{
		{ID: 7, WarehouseID: 1, Name: "other", Status: "NEW", IsExpress: false},
		{ID: 9, WarehouseID: 2, Name: "Express", Status: "ACTIVE", IsExpress: true},
		{ID: 4, WarehouseID: 1, Name: "", Status: "ACTIVE", IsExpress: true},
		{ID: 3, WarehouseID: 1, Name: "Express", Status: "active", IsExpress: true},
	}
	known := int64(7)
	missing := int64(8)
	empty := ""
	name := "Express"
	filters := []*string{nil, &empty, &name}
	knowns := []*int64{nil, &known, &missing}
	for _, filter := range filters {
		for _, id := range knowns {
			got := PickMethod(filter, 1, id, methods)
			want := legacyPickMethod(filter, 1, id, methods)
			if pickIndex(methods, got) != pickIndex(methods, want) {
				t.Fatalf("filter %v known %v got %d want %d", filter, id, pickIndex(methods, got), pickIndex(methods, want))
			}
		}
	}
	if pickIndex(methods, PickMethod(nil, 1, &known, methods)) != 0 {
		t.Fatal("known id must alias the original row")
	}

	now := int64(1_000_000)
	fresh := now - 1000
	stale := now - 15*60*1000 - 1
	edge := now - 15*60*1000
	wh := int64(1)
	facts := []SafeFact{
		{Found: true, Mode: "aggregator", Status: "unknown", RemoteAbsentAtMs: &fresh},
		{Found: true, Mode: "non_integrated", Status: "unknown", RemoteAbsentAtMs: &fresh},
		{Mode: "aggregator", Status: "unknown", RemoteAbsentAtMs: &fresh},
		{Found: true, Mode: "aggregator", Status: "failed", RemoteAbsentAtMs: &fresh},
		{Found: true, Mode: "aggregator", Status: "unknown"},
		{Found: true, Mode: "aggregator", Status: "unknown", WarehouseID: &wh, RemoteAbsentAtMs: &fresh},
		{Found: true, Mode: "aggregator", Status: "waiting", RemoteAbsentAtMs: &fresh},
		{Found: true, Mode: "aggregator", Status: "unknown", RemoteAbsentAtMs: &stale},
		{Found: true, Mode: "aggregator", Status: "unknown", RemoteAbsentAtMs: &edge},
		{Found: true, Mode: "aggregator", Status: "queued", RemoteAbsentAtMs: &fresh},
	}
	for _, f := range facts {
		got, want := SafeContinueBlock(now, f), legacySafeContinueBlock(now, f)
		if (got == nil) != (want == nil) || (got != nil && (got.Status != want.Status || got.Code != want.Code || got.Error() != want.Error())) {
			t.Fatalf("%+v got %#v want %#v", f, got, want)
		}
	}
	for _, status := range []string{"unknown", "failed", "waiting", "succeeded", "queued", ""} {
		for _, absent := range []*int64{nil, &fresh} {
			got, want := safeError(status, absent), legacySafeError(status, absent)
			if (got == nil) != (want == nil) || (got != nil && *got != *want) {
				t.Fatalf("safe %s %v", status, absent)
			}
			open := InjectionView(Diagnostic{Status: status, RemoteAbsentAtMs: absent}, 0)
			if open.CanSafeContinue != (status == "unknown" && absent != nil) {
				t.Fatalf("can %s %v", status, absent)
			}
			closed := InjectionView(Diagnostic{Status: status, RemoteAbsentAtMs: absent, WarehouseID: &wh}, 0)
			if closed.CanSafeContinue {
				t.Fatalf("warehouse %s", status)
			}
		}
		if Inflight(status) != legacyInflight(status) {
			t.Fatalf("inflight %s", status)
		}
	}
}

func pickIndex(methods []ListedMethod, got *ListedMethod) int {
	if got == nil {
		return -1
	}
	for i := range methods {
		if got == &methods[i] {
			return i
		}
	}
	return -2
}

func legacyPickMethod(wanted *string, warehouseID int64, known *int64, methods []ListedMethod) *ListedMethod {
	if known != nil {
		for i := range methods {
			if methods[i].ID == *known {
				return &methods[i]
			}
		}
	}
	for i := range methods {
		row := &methods[i]
		if row.WarehouseID != warehouseID || !row.IsExpress {
			continue
		}
		if wanted == nil || row.Name == *wanted {
			return row
		}
	}
	return nil
}

func legacySafeContinueBlock(now int64, f SafeFact) *APIError {
	const freshMS = 15 * 60 * 1000
	if f.Mode == "non_integrated" {
		return Fail(400, "VALIDATION", "非聚合模式不支持一键注入")
	}
	if !f.Found {
		return Fail(400, "VALIDATION", "没有注入事实")
	}
	if f.RemoteAbsentAtMs == nil || f.WarehouseID != nil || f.Status != "unknown" || legacyInflight(f.Status) {
		return Fail(400, "VALIDATION", "须先重新核对并证明远端不存在")
	}
	if now-*f.RemoteAbsentAtMs > freshMS {
		return Fail(400, "VALIDATION", "远端不存在证明已过期，请先重新核对")
	}
	return nil
}

func legacySafeError(status string, absent *int64) *string {
	switch status {
	case "unknown":
		if absent != nil {
			s := "远端未找到同名仓库，可安全继续"
			return &s
		}
		s := "结果未知，尚未证明远端不存在"
		return &s
	case "failed":
		s := "注入已失败"
		return &s
	default:
		return nil
	}
}

func legacyInflight(status string) bool {
	return status == "queued" || status == "submitting" || status == "waiting"
}
