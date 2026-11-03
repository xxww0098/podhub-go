package domain

import (
	"bytes"
	"encoding/json"
	"strconv"
)

// StoredRow is the listing_rows columns a view is built from.
type StoredRow struct {
	ID                string
	CardID            string
	StoreID           *string
	Revision          int64
	ViewRevision      int64
	Content           string
	Media             string
	Validation        string
	Submission        string
	BuildState        string
	Payload           []byte
	BuildSources      []byte
	UpdatedAtMs       int64
	CandidatesSettled bool
	// Receipt is the newest submission_intents.submission_receipt for this row.
	// listing_rows has no receipt column. Null and empty are absent.
	Receipt []byte
	// LatestIntent is the newest input revision's durable intent evidence.
	// It must match Revision before any issue is projected onto this row.
	LatestIntent []byte
	// RecognizeJob, UploadJob, and SliceJob are non-terminal browser jobs
	// whose cancel has not been requested. Stage uses them after the
	// submission column.
	RecognizeJob bool
	UploadJob    bool
	SliceJob     bool
}

// RowView is ListingRowView in serde field order.
type RowView struct {
	ID               string          `json:"id"`
	CardID           string          `json:"card_id"`
	StoreID          *string         `json:"store_id,omitempty"`
	Revision         int64           `json:"revision"`
	ViewRevision     int64           `json:"view_revision"`
	Projection       Projection      `json:"projection"`
	ContentState     string          `json:"content_state"`
	MediaState       string          `json:"media_state"`
	ValidationState  string          `json:"validation_state"`
	SubmissionState  string          `json:"submission_state"`
	Draft            json.RawMessage `json:"draft"`
	ValidationIssues json.RawMessage `json:"validation_issues"`
	Media            json.RawMessage `json:"media"`
	RenderEvidence   json.RawMessage `json:"render_evidence,omitempty"`
	AI               json.RawMessage `json:"ai"`
	Source           json.RawMessage `json:"source"`
	Payload          json.RawMessage `json:"payload"`
	UpdatedAtMs      int64           `json:"updated_at_ms"`
	Build            BuildView       `json:"build"`
}

// Projection is ListingRowProjection at the declared HTTP boundary.
type Projection struct {
	ReceiptStatus     string          `json:"submission_receipt_status"`
	IssueStatus       string          `json:"current_issue_status"`
	CanResume         bool            `json:"can_resume"`
	Stage             string          `json:"stage"`
	AI                string          `json:"ai"`
	Media             string          `json:"media"`
	MediaFailure      string          `json:"media_failure_stage,omitempty"`
	Fields            string          `json:"fields"`
	Readiness         Readiness       `json:"readiness"`
	ImageTotal        uint32          `json:"image_total"`
	ImageDone         uint32          `json:"image_completed"`
	ErrorCode         *string         `json:"error_code,omitempty"`
	ErrorDetail       *string         `json:"error_detail,omitempty"`
	SubmissionIssue   json.RawMessage `json:"submission_issue,omitempty"`
	SubmissionReceipt json.RawMessage `json:"submission_receipt,omitempty"`
	TaskID            *string         `json:"task_id,omitempty"`
	SKU               *int64          `json:"sku,omitempty"`
	ProductID         *int64          `json:"product_id,omitempty"`
}

// Readiness is WorkflowReadinessReport. It has no rename_all.
type Readiness struct {
	Ready    bool     `json:"ready_to_publish"`
	CanStart bool     `json:"can_start_publish_attempt"`
	Blockers []string `json:"blockers"`
	Allowed  []string `json:"allowed_actions"`
}

// BuildView is ListingRowBuildView.
type BuildView struct {
	State   string          `json:"state"`
	Sources json.RawMessage `json:"sources"`
}

// SnapshotSummary is the six prepare counters. Every field is present, including zero.
type SnapshotSummary struct {
	Unprepared uint32 `json:"unprepared"`
	Preparing  uint32 `json:"preparing"`
	Attention  uint32 `json:"attention"`
	Ready      uint32 `json:"ready"`
	Sending    uint32 `json:"sending"`
	Sent       uint32 `json:"sent"`
}

// ProjectRow builds the HTTP view from stored columns. Stage names follow the
// column facts in facts.go and the stage enum in the row spec. The priority
// follows prepare_ui_phase: submission, then recognition and media jobs,
// then content that is not ready, then candidates, validation, and build.
// SummaryOf buckets those stage names.
func ProjectRow(row StoredRow) RowView {
	body := objectOrEmpty(row.Payload)
	draft := section(body, "draft", `{}`)
	issues := section(body, "validationIssues", `[]`)
	media := section(body, "media", `{}`)
	ai := section(body, "ai", `{}`)
	source := section(body, "source", `{}`)
	var evidence json.RawMessage
	if raw, ok := body["renderEvidence"]; ok && string(bytes.TrimSpace(raw)) != "null" && len(bytes.TrimSpace(raw)) > 0 {
		evidence = raw
	}
	payload, _ := json.Marshal(body)
	if len(payload) == 0 {
		payload = []byte(`{}`)
	}
	total, done := imageCounts(media)
	row.CandidatesSettled = candidatesSettled(ai)
	stage := rowStage(row)
	buildState := row.BuildState
	if buildState != "built" {
		buildState = "stale"
	}
	sources := json.RawMessage(`[]`)
	if len(bytes.TrimSpace(row.BuildSources)) > 0 && bytes.TrimSpace(row.BuildSources)[0] == '[' {
		sources = row.BuildSources
	}
	store := row.StoreID
	if store != nil && *store == "" {
		store = nil
	}
	view := RowView{
		ID: row.ID, CardID: row.CardID, StoreID: store,
		Revision: row.Revision, ViewRevision: row.ViewRevision,
		Projection: Projection{
			ReceiptStatus: receiptStatus(row.Receipt), IssueStatus: "absent",
			CanResume: row.Submission == "unknown",
			Stage:     stage, AI: aiPhase(row.Content), Media: mediaPhase(row.Media),
			MediaFailure: mediaFailure(row.Media), Fields: fieldPhase(row.Validation),
			Readiness: readiness(stage, row), ImageTotal: total, ImageDone: done,
		},
		ContentState: row.Content, MediaState: row.Media,
		ValidationState: row.Validation, SubmissionState: row.Submission,
		Draft: draft, ValidationIssues: issues, Media: media, RenderEvidence: evidence,
		AI: ai, Source: source, Payload: payload, UpdatedAtMs: row.UpdatedAtMs,
		Build: BuildView{State: buildState, Sources: sources},
	}
	_, view.Projection.SubmissionReceipt = receiptOf(row.Receipt)
	projectLatestIntent(row, &view.Projection)
	return view
}

func projectLatestIntent(row StoredRow, projection *Projection) {
	var stored struct {
		Revision int64           `json:"row_revision"`
		State    string          `json:"state"`
		Error    *string         `json:"last_error_code"`
		Issues   json.RawMessage `json:"submission_issues"`
		Outcome  json.RawMessage `json:"reconciliation_outcome"`
		TaskID   *string         `json:"external_task_id"`
	}
	if json.Unmarshal(row.LatestIntent, &stored) != nil || stored.Revision != row.Revision {
		return
	}
	if stored.TaskID != nil {
		if task, err := strconv.ParseInt(*stored.TaskID, 10, 64); err == nil && task > 0 {
			projection.TaskID = stored.TaskID
		}
	}
	// The accepted receipt keeps the identifiers Ozon returned. They belong to
	// the row only while the intent revision matches the current input.
	var found struct {
		Found *struct {
			ProductID int64 `json:"productId"`
			SKU       int64 `json:"sku"`
		} `json:"found"`
	}
	if len(stored.Outcome) > 0 && json.Unmarshal(stored.Outcome, &found) == nil && found.Found != nil {
		if found.Found.ProductID > 0 {
			productID := found.Found.ProductID
			projection.ProductID = &productID
		}
		if found.Found.SKU > 0 {
			sku := found.Found.SKU
			projection.SKU = &sku
		}
	}
	src := IntentSource{State: stored.State, RowRevision: stored.Revision, LastErrorCode: stored.Error, SubmissionIssues: stored.Issues, ReconciliationOutcome: stored.Outcome}
	if row.Submission != "accepted" || !acceptedTaskFailed(src) {
		return
	}
	intent := ProjectIntent(src)
	projection.IssueStatus = intent.CurrentIssueStatus
	if intent.CurrentIssueStatus != IssuePresent {
		return
	}
	var issue struct {
		InputRevision int64  `json:"input_revision"`
		Summary       string `json:"summary"`
	}
	if json.Unmarshal(intent.CurrentIssue, &issue) != nil || issue.InputRevision != row.Revision {
		projection.IssueStatus = IssueAbsent
		return
	}
	projection.SubmissionIssue = intent.CurrentIssue
	projection.ErrorCode = stored.Error
	projection.ErrorDetail = &issue.Summary
	projection.CanResume = false
}

// SummaryOf counts prepare buckets from stage names.
func SummaryOf(views []RowView) SnapshotSummary {
	var sum SnapshotSummary
	for _, view := range views {
		switch view.Projection.Stage {
		case "recognizing", "rendering", "uploading":
			sum.Preparing++
		case "recognition_failed", "media_failed", "candidates_pending", "fields_invalid", "build_stale", "publish_rejected", "outcome_unknown", "operator_attested":
			sum.Attention++
		case "ready_to_publish":
			sum.Ready++
		case "queued", "submitting":
			sum.Sending++
		case "accepted":
			sum.Sent++
		default:
			sum.Unprepared++
		}
	}
	return sum
}

func rowStage(row StoredRow) string {
	switch row.Submission {
	case "operator_attested":
		return "operator_attested"
	case "accepted", "reconciled":
		return "accepted"
	case "conflict", "rejected":
		return "publish_rejected"
	case "submitting":
		return "submitting"
	case "queued":
		return "queued"
	case "none", "cancelled", "superseded":
		// Submission evidence is absent. Fall through to preparation.
	case "unknown":
		return "outcome_unknown"
	default:
		return "outcome_unknown"
	}
	if row.Content == "failed" {
		return "recognition_failed"
	}
	if row.Media == "failed" {
		return "media_failed"
	}
	if row.Content == "recognizing" || (row.Content == "draft" && row.RecognizeJob) {
		return "recognizing"
	}
	if row.Media == "uploading" || ((row.Media == "pending" || row.Media == "rendered") && row.UploadJob) {
		return "uploading"
	}
	if row.Media == "processing" || row.Media == "rendered" || (row.Media == "pending" && row.SliceJob) {
		return "rendering"
	}
	if row.Content != "ready" || row.Media != "ready" {
		return "awaiting_content"
	}
	if !row.CandidatesSettled {
		return "candidates_pending"
	}
	if row.Validation == "blocked" {
		return "fields_invalid"
	}
	if row.Validation == "stale" || row.BuildState != "built" {
		return "build_stale"
	}
	return "ready_to_publish"
}

func receiptStatus(raw []byte) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "absent"
	}
	if trimmed[0] == '{' {
		return "valid"
	}
	return "unreadable"
}

func aiPhase(content string) string {
	switch content {
	case "recognizing":
		return "running"
	case "ready":
		return "ready"
	case "failed":
		return "failed"
	default:
		return "pending"
	}
}

func mediaPhase(state string) string {
	switch state {
	case "processing":
		return "rendering"
	case "rendered":
		return "rendered"
	case "uploading":
		return "uploading"
	case "ready":
		return "ready"
	case "failed":
		return "failed"
	default:
		return "pending"
	}
}

func mediaFailure(state string) string {
	if state == "failed" {
		return "upload"
	}
	return ""
}

func fieldPhase(validation string) string {
	switch validation {
	case "blocked":
		return "invalid"
	case "passed":
		return "valid"
	default:
		return "dirty"
	}
}

func readiness(stage string, row StoredRow) Readiness {
	var blockers []string
	switch aiPhase(row.Content) {
	case "pending":
		blockers = append(blockers, "ai_pending")
	case "running":
		blockers = append(blockers, "ai_running")
	case "failed":
		blockers = append(blockers, "ai_failed")
	}
	if !row.CandidatesSettled {
		blockers = append(blockers, "candidates_unsettled")
	}
	switch mediaPhase(row.Media) {
	case "pending", "rendered":
		blockers = append(blockers, "media_pending")
	case "rendering", "uploading":
		blockers = append(blockers, "media_running")
	case "failed":
		blockers = append(blockers, "media_failed")
	}
	switch fieldPhase(row.Validation) {
	case "dirty":
		blockers = append(blockers, "fields_dirty")
	case "invalid":
		blockers = append(blockers, "fields_invalid")
	}
	switch row.Submission {
	case "unknown":
		blockers = append(blockers, "outcome_unknown")
	case "rejected":
		blockers = append(blockers, "publish_rejected")
	}
	if blockers == nil {
		blockers = []string{}
	}
	allowed := []string{}
	ready := stage == "ready_to_publish"
	canStart := ready || stage == "build_stale"
	if canStart {
		allowed = append(allowed, "publish")
	} else if stage != "accepted" {
		allowed = append(allowed, "prepare", "edit_fields")
	}
	return Readiness{Ready: ready, CanStart: canStart, Blockers: blockers, Allowed: allowed}
}

func objectOrEmpty(raw []byte) map[string]json.RawMessage {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(raw, &body); err != nil || body == nil {
		return map[string]json.RawMessage{}
	}
	return body
}

func section(body map[string]json.RawMessage, key, fallback string) json.RawMessage {
	raw := body[key]
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return json.RawMessage(fallback)
	}
	return raw
}

func candidatesSettled(ai json.RawMessage) bool {
	var body struct {
		Candidates []struct {
			State string `json:"state"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(ai, &body); err != nil || body.Candidates == nil {
		return true
	}
	for _, item := range body.Candidates {
		if item.State != "confirmed" && item.State != "rejected" {
			return false
		}
	}
	return true
}

func imageCounts(media json.RawMessage) (uint32, uint32) {
	var body struct {
		Images []struct {
			Phase string `json:"phase"`
		} `json:"images"`
	}
	if err := json.Unmarshal(media, &body); err != nil {
		return 0, 0
	}
	var done uint32
	for _, image := range body.Images {
		if image.Phase == "public_ready" {
			done++
		}
	}
	return uint32(len(body.Images)), done
}
