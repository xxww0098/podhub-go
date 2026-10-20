package domain

import (
	"testing"

	delegatecontract "github.com/xxww0098/podhub-go/internal/admin/delegate/contract"
)

func TestPostingSnapshotAndReceipt(t *testing.T) {
	got := string(ProjectPostingSnapshot([]byte(`{"missing_ticks":3,"shipment_date":"2026-01-02","status":"awaiting"}`)))
	if got != `{"status":"awaiting","shipment_date":"2026-01-02"}` {
		t.Fatal(got)
	}
	if string(ProjectPostingSnapshot([]byte(`{"missing_ticks":1}`))) != `{}` {
		t.Fatal(ProjectPostingSnapshot([]byte(`{"missing_ticks":1}`)))
	}
	r := ProjectReceipt([]byte(`{"tracking_no":"","note":"线下沟通后补录","recorded_by":"admin:42","at_ms":"1789900000000"}`))
	if r == nil || r.TrackingNo != nil || r.Note == nil || *r.Note != "线下沟通后补录" || r.AtMs != nil || r.RecordedBy == nil {
		t.Fatalf("%+v", r)
	}
	r = ProjectReceipt([]byte(`{"reason":"太急了","at_ms":7}`))
	if r == nil || r.Reason == nil || *r.Reason != "太急了" || r.AtMs == nil || *r.AtMs != 7 {
		t.Fatalf("%+v", r)
	}
	if ProjectReceipt([]byte(`{"tracking_no":"","note":""}`)) != nil {
		t.Fatal("empty receipt")
	}
	names := StringList([]byte(`["管理厂家甲", 1, null, "管理厂家乙"]`))
	if len(names) != 2 || names[0] != "管理厂家甲" || names[1] != "管理厂家乙" {
		t.Fatal(names)
	}
}

func TestPageCursor(t *testing.T) {
	rows := []delegatecontract.OrderRow{{OrderID: "a", CreatedAtMs: 2}, {OrderID: "b", CreatedAtMs: 1}}
	page := Page(rows, 1)
	if !page.Data.HasNext || len(page.Data.Orders) != 1 || page.Data.Cursor != "2:a" {
		t.Fatalf("%+v", page.Data)
	}
	last := Page(rows[:1], 1)
	if last.Data.HasNext || last.Data.Cursor != "" {
		t.Fatalf("%+v", last.Data)
	}
}
