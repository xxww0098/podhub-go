package domain

import (
	"encoding/json"
	"os"
	"testing"
)

func i64p(n int64) *int64 { return &n }

func TestMapAggregatorCreateMatchesFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/warehouse_erfbs_aggregator_create_v1_request.json")
	if err != nil {
		t.Fatal(err)
	}
	minV := int64(500)
	body, err := MapAggregatorCreate(Preset{
		Mode: "aggregator", CutIn: 60,
		Address:        Coordinates{Latitude: 55.69626, Longitude: 37.42686},
		IsAutoAssembly: true,
		CourierComment: "Comment",
		CourierPhones:  []string{"+7(999)999-99-99"},
		DeliverToPVZ:   true,
		DeliveryCosts: &Costs{
			MinWeight: i64p(0), MaxWeight: i64p(5000),
			MinOrderPrice: i64p(0), MaxOrderPrice: i64p(10000), SellerPayment: i64p(200),
		},
		DeliveryMethodName: "Partners Ozon",
		ReturnSettings: &ReturnSettings{
			ContactDays: i64p(3), PostOfficeZipcode: "125009", ReturnMethod: "COURIER",
		},
		MinOrderValue: &minV,
		WarehouseName: "Express warehouse",
		Phone:         "+7(999)999-99-99",
		Timetable: Timetable{
			Holidays: []Holiday{{Day: "2026-01-01", From: "00:00", To: "23:59"}},
			WorkingDays: []WorkingHours{
				{Day: "MONDAY", From: "09:00", To: "18:00"},
				{Day: "TUESDAY", From: "09:00", To: "18:00"},
				{Day: "WEDNESDAY", From: "09:00", To: "18:00"},
				{Day: "THURSDAY", From: "09:00", To: "18:00"},
				{Day: "FRIDAY", From: "09:00", To: "18:00"},
			},
		},
		WeightUnit: "g",
	})
	if err != nil {
		t.Fatal(err)
	}
	var got, want any
	if json.Unmarshal(body, &got) != nil || json.Unmarshal(raw, &want) != nil {
		t.Fatal("json")
	}
	gb, _ := json.Marshal(got)
	wb, _ := json.Marshal(want)
	if string(gb) != string(wb) {
		t.Fatalf("got %s\nwant %s", gb, wb)
	}
}

func TestMapRejectsNonAggregatorAndBadCutIn(t *testing.T) {
	if _, err := MapAggregatorCreate(Preset{Mode: "non_integrated", CutIn: 60}); err == nil {
		t.Fatal("mode")
	}
	if _, err := MapAggregatorCreate(Preset{Mode: "aggregator", CutIn: 45}); err == nil {
		t.Fatal("cut")
	}
}

func TestKilogramsBecomeGramsAndUnpinnedSkipsWeights(t *testing.T) {
	body, err := MapAggregatorCreate(Preset{
		Mode: "aggregator", CutIn: 15, WarehouseName: "w", Phone: "p", DeliveryMethodName: "d",
		WeightUnit: "kg", DeliveryCosts: &Costs{MinWeight: i64p(2), SellerPayment: i64p(1)},
	})
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		DeliveryMethod struct {
			Costs *Costs `json:"delivery_costs"`
		} `json:"delivery_method"`
	}
	if json.Unmarshal(body, &got) != nil || got.DeliveryMethod.Costs == nil || *got.DeliveryMethod.Costs.MinWeight != 2000 {
		t.Fatalf("%s", body)
	}
	skipped, err := MapAggregatorCreate(Preset{
		Mode: "aggregator", CutIn: 15, WeightUnit: "unpinned",
		DeliveryCosts: &Costs{MinWeight: i64p(2), SellerPayment: i64p(1)},
	})
	if err != nil {
		t.Fatal(err)
	}
	var again struct {
		DeliveryMethod struct {
			Costs *Costs `json:"delivery_costs"`
		} `json:"delivery_method"`
	}
	if json.Unmarshal(skipped, &again) != nil || again.DeliveryMethod.Costs == nil || again.DeliveryMethod.Costs.MinWeight != nil {
		t.Fatalf("%s", skipped)
	}
}

func TestClassifyMutateTable(t *testing.T) {
	cases := []struct {
		k    MutateKind
		want Outcome
	}{
		{MutateKind{Status: 200, OperationID: "op"}, Accepted},
		{MutateKind{Status: 200}, LostAfterSend},
		{MutateKind{Status: 500}, LostAfterSend},
		{MutateKind{Status: 429}, Failed},
		{MutateKind{Status: 400}, Failed},
		{MutateKind{Config: true, Status: 500}, Failed},
		{MutateKind{Decode: true}, LostAfterSend},
		{MutateKind{Transport: true, Connect: true}, Failed},
		{MutateKind{Transport: true}, LostAfterSend},
	}
	for _, c := range cases {
		got, _ := ClassifyMutate(c.k)
		if got != c.want {
			t.Fatalf("%+v -> %s", c.k, got)
		}
	}
}

func TestSafeContinueGuardAndView(t *testing.T) {
	now := int64(1_000_000)
	fresh := now - 1000
	if err := SafeContinueGuard("unknown", &fresh, nil, now); err != nil {
		t.Fatal(err)
	}
	stale := now - AbsenceFreshMS - 1
	if GuardMessage(SafeContinueGuard("unknown", &stale, nil, now)) != "远端不存在证明已过期，请先重新核对" {
		t.Fatal("stale")
	}
	wh := int64(1)
	if GuardMessage(SafeContinueGuard("unknown", &fresh, &wh, now)) != "须先重新核对并证明远端不存在" {
		t.Fatal("warehouse")
	}
	if GuardMessage(SafeContinueGuard("waiting", &fresh, nil, now)) == "" {
		t.Fatal("inflight")
	}
	if !CanSafeContinue("unknown", &stale, nil) {
		t.Fatal("flag ignores freshness")
	}
	if SafeError("unknown", &fresh) != "远端未找到同名仓库，可安全继续" || SafeError("failed", nil) != "注入已失败" || SafeError("waiting", nil) != "" {
		t.Fatal("safe error")
	}
	if RemoteAbsentAt("unknown", nil, true, 7) == nil || *RemoteAbsentAt("unknown", nil, true, 7) != 7 {
		t.Fatal("proof")
	}
	if RemoteAbsentAt("unknown", &wh, true, 7) != nil || RemoteAbsentAt("failed", nil, true, 7) != nil {
		t.Fatal("no proof")
	}
}

func TestIdempotencyKeys(t *testing.T) {
	if ReconcileKey("s", "p", 3) != "ship-inject:s:p:3:reconcile" {
		t.Fatal(ReconcileKey("s", "p", 3))
	}
	a := SafeContinueKey("s", "p", 3, 10)
	b := SafeContinueKey("s", "p", 3, 11)
	if a == b || a != "ship-inject:s:p:3:safe-continue:10" {
		t.Fatal(a, b)
	}
}
