package domain

import (
	"strings"
	"testing"
)

func TestProjectRowFreshDraftIsBuildStale(t *testing.T) {
	view := ProjectRow(StoredRow{
		ID: "r", CardID: "c", Revision: 1, ViewRevision: 1,
		Content: "draft", Media: "pending", Validation: "stale", Submission: "none",
		BuildState: "stale", Payload: []byte(`{"draft":{"values":{}},"schemaSnapshot":{"x":1}}`),
		UpdatedAtMs: 10,
	})
	if view.Projection.Stage != "awaiting_content" || view.Projection.AI != "pending" || view.Projection.Fields != "dirty" {
		t.Fatalf("%+v", view.Projection)
	}
	if !strings.Contains(string(view.Payload), "schemaSnapshot") {
		t.Fatalf("payload %s", view.Payload)
	}
	sum := SummaryOf([]RowView{view})
	if sum.Unprepared != 1 || sum.Attention != 0 {
		t.Fatalf("%+v", sum)
	}
}
