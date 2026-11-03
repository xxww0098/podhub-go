package domain

import (
	"encoding/json"
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

func TestProjectAcceptedIdentifiersStayWithTheCurrentInput(t *testing.T) {
	const latest = `{"row_revision":4,"state":"accepted","external_task_id":"71","reconciliation_outcome":{"found":{"productId":6835063272,"sku":6222103169},"importTask":{"status":"imported"}}}`
	row := StoredRow{ID: "row", CardID: "card", Revision: 4, Submission: "accepted", LatestIntent: []byte(latest)}
	projection := ProjectRow(row).Projection
	if projection.ProductID == nil || *projection.ProductID != 6835063272 || projection.SKU == nil || *projection.SKU != 6222103169 {
		t.Fatalf("accepted identifiers missing: %+v", projection)
	}

	pending := row
	pending.LatestIntent = []byte(strings.Replace(latest, `"sku":6222103169`, `"sku":0`, 1))
	projection = ProjectRow(pending).Projection
	if projection.ProductID == nil || *projection.ProductID != 6835063272 {
		t.Fatalf("confirmed product id was dropped: %+v", projection)
	}
	if projection.SKU != nil {
		t.Fatalf("unpublished sku was invented: %+v", projection)
	}

	old := row
	old.LatestIntent = []byte(strings.Replace(latest, `"row_revision":4`, `"row_revision":3`, 1))
	projection = ProjectRow(old).Projection
	if projection.ProductID != nil || projection.SKU != nil {
		t.Fatalf("identifiers from an old input revision leaked into row: %+v", projection)
	}
}

func TestProjectAcceptedTaskFailureUsesOnlyCurrentInputEvidence(t *testing.T) {
	const latest = `{"row_revision":4,"state":"accepted","last_error_code":"OZON_ROW_REJECTED","external_task_id":"71","submission_issues":[{"code":"OZON_ROW_REJECTED","summary":"异步导入失败","inputRevision":4,"resolvedAtMs":null,"allowedActions":["edit_row","resume"]}],"reconciliation_outcome":{"importTask":{"status":"failed"}}}`
	base := StoredRow{ID: "row", CardID: "card", Revision: 4, Submission: "accepted", LatestIntent: []byte(latest)}
	view := ProjectRow(base)
	projection := view.Projection
	if view.SubmissionState != "accepted" || projection.Stage != "accepted" || projection.IssueStatus != IssuePresent || projection.ErrorCode == nil || *projection.ErrorCode != "OZON_ROW_REJECTED" || projection.TaskID == nil || *projection.TaskID != "71" || projection.CanResume {
		t.Fatalf("failure evidence lost acceptance boundary: %+v", projection)
	}
	if len(projection.Readiness.Allowed) != 0 || projection.Readiness.CanStart || projection.Readiness.Ready {
		t.Fatalf("accepted record offered a new write: %+v", projection.Readiness)
	}
	var issue struct {
		Revision int64    `json:"input_revision"`
		Actions  []string `json:"allowed_actions"`
	}
	if err := json.Unmarshal(projection.SubmissionIssue, &issue); err != nil || issue.Revision != 4 || len(issue.Actions) != 1 || issue.Actions[0] != "check_store" {
		t.Fatalf("issue was not a read-only current-input wire view: %s", projection.SubmissionIssue)
	}
	imported := base
	imported.LatestIntent = []byte(strings.Replace(latest, `"status":"failed"`, `"status":"imported","errors":[{"level":"error","code":"SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT"}]`, 1))
	if got := ProjectRow(imported).Projection; got.IssueStatus != IssuePresent || got.ErrorDetail == nil || got.CanResume {
		t.Fatalf("imported moderation failure was hidden: %+v", got)
	}
	for name, latest := range map[string]string{
		"pending task":          strings.Replace(latest, `"status":"failed"`, `"status":"pending"`, 1),
		"imported task warning": strings.Replace(latest, `"status":"failed"`, `"status":"imported"`, 1),
		"old intent":            strings.Replace(latest, `"row_revision":4`, `"row_revision":3`, 1),
		"old issue":             strings.Replace(latest, `"inputRevision":4`, `"inputRevision":3`, 1),
		"resolved issue":        strings.Replace(latest, `"resolvedAtMs":null`, `"resolvedAtMs":5`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			row := base
			row.LatestIntent = []byte(latest)
			got := ProjectRow(row).Projection
			if got.ErrorCode != nil || len(got.SubmissionIssue) != 0 || got.IssueStatus != IssueAbsent || got.CanResume || got.Stage != "accepted" {
				t.Fatalf("non-current failure leaked into row: %+v", got)
			}
		})
	}
}
