package domain

import (
	"errors"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/warehouse/contract"
)

func TestParseWarehousesAndObsolete(t *testing.T) {
	raw := []byte(`{
		"cursor":"c2","has_next":true,
		"warehouses":[
			{"warehouse_id":7,"name":"A","status":"created","is_rfbs":true},
			{"warehouse_id":0,"name":"skip"},
			{"warehouse_id":7,"name":"A2","status":"created","is_rfbs":false}
		]
	}`)
	page, err := ParseWarehouses(raw)
	if err != nil || page.Obsolete || !page.HasNext || page.Cursor != "c2" || len(page.Rows) != 1 {
		t.Fatalf("%+v %v", page, err)
	}
	if page.Rows[0].Name != "A2" || page.Rows[0].IsRFBS || !IsActive(page.Rows[0].Status, false) {
		t.Fatal(page.Rows[0])
	}
	nested := []byte(`{"result":{"warehouses":[{"warehouse_id":3,"name":"B","status":"created","is_rfbs":true}]}}`)
	page, err = ParseWarehouses(nested)
	if err != nil || len(page.Rows) != 1 || page.Rows[0].WarehouseID != 3 {
		t.Fatal(page, err)
	}
	old := []byte(`{"code":9,"message":"obsolete method"}`)
	page, err = ParseWarehouses(old)
	if err != nil || !page.Obsolete || len(page.Rows) != 0 {
		t.Fatal(page, err)
	}
	if !Obsolete([]byte(`{"message":"Method is Obsolete"}`)) {
		t.Fatal("message")
	}
}

func TestParseMethodsKeepsVerifiedFieldsAsText(t *testing.T) {
	raw := []byte(`{
		"has_next":false,
		"result":[{
			"id":11,"name":"快递","warehouse_id":7,"provider_id":4,"template_id":"tpl",
			"cutoff":"18:00","sla_cut_in":90,"status":"ACTIVE",
			"created_at":"2026-01-02T03:04:05Z","updated_at":"2026-01-03T03:04:05Z"
		}]
	}`)
	page, err := ParseMethods(raw)
	if err != nil || len(page.Rows) != 1 {
		t.Fatal(page, err)
	}
	got := page.Rows[0]
	want := contract.Method{
		MethodID: 11, WarehouseID: 7, Name: "快递", ProviderID: "4", TemplateID: "tpl",
		Cutoff: "18:00", SLACutIn: "90", Status: "ACTIVE",
		CreatedAt: "2026-01-02T03:04:05Z", UpdatedAt: "2026-01-03T03:04:05Z",
	}
	if got != want {
		t.Fatalf("%+v", got)
	}
	alt := []byte(`{"delivery_methods":[{"id":2,"name":"自提","warehouse_id":7,"status":"DISABLED"}]}`)
	page, err = ParseMethods(alt)
	if err != nil || len(page.Rows) != 1 || page.Rows[0].Status != "DISABLED" {
		t.Fatal(page, err)
	}
}

func TestParseOperation(t *testing.T) {
	got, err := ParseOperation([]byte(`{"status":"SUCCESS","result":{"warehouse_id":7}}`))
	if err != nil || got.Status != "SUCCESS" || got.WarehouseID == nil || *got.WarehouseID != 7 {
		t.Fatal(got, err)
	}
}

func TestArchiveGuards(t *testing.T) {
	active := &contract.Warehouse{Status: ActiveStatus}
	archived := &contract.Warehouse{Status: ActiveStatus, Archived: true}
	if err := CheckWrite(contract.KindArchive, false, 7, active, true); !errors.Is(err, contract.ConfirmRequired()) {
		t.Fatal(err)
	}
	if err := CheckWrite(contract.KindArchive, true, 0, active, true); !errors.Is(err, contract.ConfirmRequired()) {
		t.Fatal(err)
	}
	if err := CheckWrite(contract.KindArchive, true, 7, active, true); err != nil {
		t.Fatal(err)
	}
	if err := CheckWrite(contract.KindArchive, true, 7, archived, true); !errors.Is(err, contract.WarehouseStatus()) {
		t.Fatal(err)
	}
	if err := CheckWrite(contract.KindArchive, true, 7, nil, false); !errors.Is(err, contract.NotSynced()) {
		t.Fatal(err)
	}
	if err := CheckWrite(contract.KindUnarchive, false, 7, archived, true); err != nil {
		t.Fatal(err)
	}
	if err := CheckWrite(contract.KindUnarchive, false, 7, active, true); !errors.Is(err, contract.WarehouseStatus()) {
		t.Fatal(err)
	}
	if err := CheckWrite(contract.KindCreate, false, 0, nil, false); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(PathWarehouseList+PathMethodList+PathOperation, "/v1/warehouse/list") {
		t.Fatal("v1 list path")
	}
}
