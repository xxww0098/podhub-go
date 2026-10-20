package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHydratePayload(t *testing.T) {
	lookup := func(revision string) (json.RawMessage, bool, error) {
		if revision != "workflow:sha256:abc" {
			return nil, false, nil
		}
		return []byte(`{"fields":[]}`), true, nil
	}
	kept, err := HydratePayload([]byte(`{"schemaSnapshot":{"x":1},"schemaRevision":"workflow:sha256:abc"}`), lookup)
	if err != nil || !strings.Contains(string(kept), `"x":1`) {
		t.Fatalf("passthrough %s %v", kept, err)
	}
	fat, err := HydratePayload([]byte(`{"draft":{}}`), lookup)
	if err != nil || strings.Contains(string(fat), "schemaSnapshot") {
		t.Fatalf("fat %s %v", fat, err)
	}
	filled, err := HydratePayload([]byte(`{"schemaRevision":"workflow:sha256:abc"}`), lookup)
	if err != nil || !strings.Contains(string(filled), `"schemaSnapshot"`) {
		t.Fatalf("filled %s %v", filled, err)
	}
	_, err = HydratePayload([]byte(`{"schemaRevision":"missing"}`), lookup)
	if err == nil || !strings.Contains(err.Error(), "is not registered") {
		t.Fatal(err)
	}
	if rev, ok := SchemaRevisionToFetch([]byte(`{"schemaRevision":"workflow:sha256:abc"}`)); !ok || rev != "workflow:sha256:abc" {
		t.Fatalf("fetch %q %v", rev, ok)
	}
	for _, raw := range []string{
		`{"schemaSnapshot":{"x":1},"schemaRevision":"workflow:sha256:abc"}`,
		`{"draft":{}}`,
		`{"schemaRevision":""}`,
		`{"schemaRevision":1}`,
		`null`,
	} {
		if _, ok := SchemaRevisionToFetch([]byte(raw)); ok {
			t.Fatalf("should skip %s", raw)
		}
	}
}

func TestRowStageAndReceipt(t *testing.T) {
	base := StoredRow{Content: "ready", Media: "ready", Validation: "passed", BuildState: "built", Submission: "none", CandidatesSettled: true}
	cases := []struct {
		name  string
		row   StoredRow
		stage string
	}{
		{"operator", StoredRow{Submission: "operator_attested"}, "operator_attested"},
		{"unknown", StoredRow{Submission: "unknown"}, "outcome_unknown"},
		{"accepted", StoredRow{Submission: "accepted"}, "accepted"},
		{"reconciled", StoredRow{Submission: "reconciled"}, "accepted"},
		{"rejected", StoredRow{Submission: "rejected"}, "publish_rejected"},
		{"submitting", StoredRow{Submission: "submitting"}, "submitting"},
		{"queued", StoredRow{Submission: "queued"}, "queued"},
		{"content failed", StoredRow{Submission: "none", Content: "failed"}, "recognition_failed"},
		{"media failed", StoredRow{Submission: "none", Content: "ready", Media: "failed"}, "media_failed"},
		{"recognizing", StoredRow{Submission: "none", Content: "recognizing"}, "recognizing"},
		{"draft job", StoredRow{Submission: "none", Content: "draft", RecognizeJob: true}, "recognizing"},
		{"uploading", StoredRow{Submission: "none", Content: "ready", Media: "uploading"}, "uploading"},
		{"upload job", StoredRow{Submission: "none", Content: "ready", Media: "pending", UploadJob: true}, "uploading"},
		{"rendering", StoredRow{Submission: "none", Content: "ready", Media: "processing"}, "rendering"},
		{"slice job", StoredRow{Submission: "none", Content: "ready", Media: "pending", SliceJob: true}, "rendering"},
		{"awaiting", StoredRow{Submission: "none", Content: "draft", Media: "pending"}, "awaiting_content"},
		{"candidates", func() StoredRow { r := base; r.CandidatesSettled = false; return r }(), "candidates_pending"},
		{"blocked", func() StoredRow { r := base; r.Validation = "blocked"; return r }(), "fields_invalid"},
		{"stale", func() StoredRow { r := base; r.Validation = "stale"; return r }(), "build_stale"},
		{"ready", base, "ready_to_publish"},
	}
	for _, tc := range cases {
		if got := rowStage(tc.row); got != tc.stage {
			t.Fatalf("%s: %s", tc.name, got)
		}
	}
	if receiptStatus(nil) != "absent" || receiptStatus([]byte("null")) != "absent" {
		t.Fatal("absent")
	}
	if receiptStatus([]byte(`{"ok":true}`)) != "valid" || receiptStatus([]byte("[]")) != "unreadable" {
		t.Fatal("receipt")
	}
	view := ProjectRow(StoredRow{
		Content: "draft", Media: "pending", Validation: "stale", Submission: "none",
		BuildState: "stale", Payload: []byte(`{"draft":{"values":{}},"schemaSnapshot":{"x":1}}`),
	})
	if view.Projection.Stage != "awaiting_content" || !strings.Contains(string(view.Payload), "schemaSnapshot") {
		t.Fatalf("%s %s", view.Projection.Stage, view.Payload)
	}
	ready := base
	ready.Validation = "stale"
	if SummaryOf([]RowView{ProjectRow(ready)}).Attention != 1 {
		t.Fatal("stale is attention")
	}
}
