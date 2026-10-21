package domain

import (
	"encoding/json"
	"sort"
	"strings"
	"time"
)

// Intent query, view, HTTP cancel, and release predicates.
// HTTP cancel is not IntentTransition::CancelBeforeDispatch.

const (
	IssueAbsent           = "absent"
	IssuePresent          = "present"
	IssueUndeterminable   = "undeterminable"
	ReceiptAbsent         = "absent"
	ReceiptValid          = "valid"
	ReceiptUnreadable     = "unreadable"
	ReconcileStillUnknown = "OZON_RECONCILE_STILL_UNKNOWN"
)

var knownIntentErrors = map[string]struct{}{
	"OZON_STORE_PAUSED": {}, "OZON_RATE_LIMITED": {}, "OZON_EGRESS_UNAVAILABLE": {},
	"OZON_EGRESS_UNREACHABLE": {}, "OZON_WRITES_DISABLED": {}, "OZON_ACCESS_UNCLASSIFIED": {},
	"SHIPPING_NOT_READY": {}, "OZON_ROW_REJECTED": {}, "OZON_CREDENTIAL_INVALID": {},
	"OZON_PERMISSION_DENIED": {}, "OZON_DISPATCH_INTERRUPTED": {}, "INTENT_PAYLOAD_UNREADABLE": {},
	"STORE_CREDENTIAL_MISSING": {}, "STORE_CREDENTIAL_EXPIRED": {}, "STORE_CREDENTIAL_ERROR": {},
	"MEDIA_LEASE_UNAVAILABLE": {}, "MEDIA_OBJECT_MISSING": {}, "cancel_requested": {},
	"OZON_SUBMIT_IN_FLIGHT": {}, "OZON_SUBMIT_NOT_DISPATCHED": {}, "OZON_SUBMIT_RETRY_EXHAUSTED": {},
}

// IntentFilter is a validated GET /api/listing/intents query.
// Nil id slices mean the filter is absent. An empty slice means AND false.
type IntentFilter struct {
	Limit        int64
	Fetch        int64
	CursorMicros int64
	CursorID     string
	LatestPerRow bool
	StableOrder  bool
	CardID       string
	RowID        string
	RowIDs       []string
	IntentIDs    []string
	StoreID      string
	ExactStore   bool
}

// ParseIntentQuery validates ListingIntentsQuery. A bad cursor is no cursor.
// categoryKey is accepted and not turned into a predicate.
func ParseIntentQuery(q map[string][]string) (IntentFilter, string, bool) {
	allowed := map[string]struct{}{
		"limit": {}, "cursor": {}, "categoryKey": {}, "cardId": {}, "latestPerRow": {},
		"stableOrder": {}, "rowId": {}, "rowIds": {}, "intentIds": {}, "storeId": {},
	}
	for key, values := range q {
		if _, ok := allowed[key]; !ok || len(values) != 1 {
			return IntentFilter{}, "请求格式无效", false
		}
	}
	limit, ok := ParseLimit(one(q, "limit"), has(q, "limit"))
	if !ok {
		return IntentFilter{}, "limit 无效", false
	}
	latest, ok := parseBool(q, "latestPerRow")
	if !ok {
		return IntentFilter{}, "请求格式无效", false
	}
	stable, ok := parseBool(q, "stableOrder")
	if !ok {
		return IntentFilter{}, "请求格式无效", false
	}
	if has(q, "rowId") && has(q, "rowIds") {
		return IntentFilter{}, "rowId 与 rowIds 不能同时使用", false
	}
	if (has(q, "rowIds") || has(q, "intentIds")) && strings.TrimSpace(one(q, "storeId")) == "" {
		return IntentFilter{}, "按 rowIds 或 intentIds 查询时 storeId 必填", false
	}
	out := IntentFilter{Limit: limit, Fetch: limit + 1, LatestPerRow: latest, StableOrder: stable}
	if out.Fetch > 101 {
		out.Fetch = 101
	}
	out.CursorMicros, out.CursorID = ParseCursor(one(q, "cursor"))
	if has(q, "cardId") {
		id, ok := CanonicalUUID(one(q, "cardId"))
		if !ok {
			return IntentFilter{}, "cardId 无效", false
		}
		out.CardID = id
	}
	if has(q, "rowId") {
		id, ok := CanonicalUUID(one(q, "rowId"))
		if !ok {
			return IntentFilter{}, "rowId 无效", false
		}
		out.RowID = id
	}
	if has(q, "storeId") && strings.TrimSpace(one(q, "storeId")) != "" {
		id, ok := CanonicalUUID(one(q, "storeId"))
		if !ok {
			return IntentFilter{}, "storeId 无效", false
		}
		out.StoreID = id
		out.ExactStore = true
	}
	if has(q, "rowIds") {
		ids, ok := parseIDList(one(q, "rowIds"))
		if !ok {
			return IntentFilter{}, "rowIds 含无效标识", false
		}
		if len(ids) > 100 {
			return IntentFilter{}, "rowIds 一次最多 100 个", false
		}
		out.RowIDs = ids
	}
	if has(q, "intentIds") {
		ids, ok := parseIDList(one(q, "intentIds"))
		if !ok {
			return IntentFilter{}, "intentIds 含无效标识", false
		}
		if len(ids) > 100 {
			return IntentFilter{}, "intentIds 一次最多 100 个", false
		}
		out.IntentIDs = ids
	}
	return out, "", true
}

func has(q map[string][]string, key string) bool {
	_, ok := q[key]
	return ok
}

func one(q map[string][]string, key string) string {
	values := q[key]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func parseBool(q map[string][]string, key string) (bool, bool) {
	if !has(q, key) {
		return false, true
	}
	switch one(q, key) {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

func parseIDList(raw string) ([]string, bool) {
	if strings.TrimSpace(raw) == "" {
		return []string{}, true
	}
	parts := strings.Split(raw, ",")
	ids := make([]string, 0, len(parts))
	seen := map[string]struct{}{}
	for _, part := range parts {
		id, ok := CanonicalUUID(part)
		if !ok {
			return nil, false
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, true
}

// ParseReleaseIDs trims, canonicalizes, sorts, and dedups. The 100 cap is after dedup.
func ParseReleaseIDs(raw []string) ([]string, string, bool) {
	if len(raw) == 0 {
		return nil, "至少选择一个提交意图", false
	}
	ids := make([]string, 0, len(raw))
	seen := map[string]struct{}{}
	for _, item := range raw {
		id, ok := CanonicalUUID(item)
		if !ok {
			return nil, "intentIds 含无效标识", false
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) > 100 {
		return nil, "一次最多处理 100 个提交意图", false
	}
	sort.Strings(ids)
	return ids, "", true
}

// IntentSource is one submission_intents row plus optional GET release facts.
// A nil fact pointer means the snapshot did not match; the view omits the field.
type IntentSource struct {
	ID                    string
	StoreID               string
	ListingRowID          string
	RowRevision           int64
	ClientOperationID     string
	State                 string
	ExternalTaskID        *string
	LastErrorCode         *string
	ReconciliationOutcome json.RawMessage
	SubmissionReceipt     json.RawMessage
	SubmissionIssues      json.RawMessage
	CancelRequestedAt     *time.Time
	UpdatedAt             time.Time
	HasLiveReconcileClaim *bool
	HasUnfinishedDispatch *bool
}

// IntentView is ListingIntentView. importProbe is omitted: its derivation is not in the spec.
type IntentView struct {
	SubmissionIssues         json.RawMessage `json:"submission_issues"`
	CurrentIssueStatus       string          `json:"current_issue_status"`
	CurrentIssue             json.RawMessage `json:"current_issue,omitempty"`
	CanResume                bool            `json:"can_resume"`
	ID                       string          `json:"id"`
	StoreID                  string          `json:"store_id"`
	ListingRowID             string          `json:"listing_row_id"`
	RowRevision              int64           `json:"row_revision"`
	ClientOperationID        string          `json:"client_operation_id"`
	State                    string          `json:"state"`
	ExternalTaskID           *string         `json:"external_task_id,omitempty"`
	LastErrorCode            *string         `json:"last_error_code,omitempty"`
	KnownErrorCode           *string         `json:"known_error_code,omitempty"`
	ReconciliationOutcome    json.RawMessage `json:"reconciliation_outcome,omitempty"`
	SubmissionReceipt        json.RawMessage `json:"submission_receipt,omitempty"`
	SubmissionReceiptStatus  string          `json:"submission_receipt_status"`
	CancelRequestedAtMs      *int64          `json:"cancel_requested_at_ms,omitempty"`
	UpdatedAtMs              int64           `json:"updated_at_ms"`
	HasLiveReconcileClaim    *bool           `json:"has_live_reconcile_claim,omitempty"`
	HasUnfinishedDispatchJob *bool           `json:"has_unfinished_dispatch_job,omitempty"`
}

// ProjectIntent builds the wire view. Facts are copied only when the pointers are set.
func ProjectIntent(src IntentSource) IntentView {
	issues := src.SubmissionIssues
	if len(bytesTrim(issues)) == 0 {
		issues = json.RawMessage("[]")
	}
	status, current, resume := currentIssue(src.State, src.LastErrorCode, issues)
	receiptStatus, receipt := receiptOf(src.SubmissionReceipt)
	var known *string
	if src.LastErrorCode != nil {
		if _, ok := knownIntentErrors[*src.LastErrorCode]; ok {
			code := *src.LastErrorCode
			known = &code
		}
	}
	var cancel *int64
	if src.CancelRequestedAt != nil {
		ms := src.CancelRequestedAt.UnixMilli()
		cancel = &ms
	}
	return IntentView{
		SubmissionIssues: issueHistoryWire(issues), CurrentIssueStatus: status, CurrentIssue: issueWire(current), CanResume: resume,
		ID: src.ID, StoreID: src.StoreID, ListingRowID: src.ListingRowID, RowRevision: src.RowRevision,
		ClientOperationID: src.ClientOperationID, State: src.State,
		ExternalTaskID: src.ExternalTaskID, LastErrorCode: src.LastErrorCode, KnownErrorCode: known,
		ReconciliationOutcome: nonNull(src.ReconciliationOutcome), SubmissionReceipt: receipt,
		SubmissionReceiptStatus: receiptStatus, CancelRequestedAtMs: cancel,
		UpdatedAtMs:           src.UpdatedAt.UnixMilli(),
		HasLiveReconcileClaim: src.HasLiveReconcileClaim, HasUnfinishedDispatchJob: src.HasUnfinishedDispatch,
	}
}

func bytesTrim(raw json.RawMessage) []byte {
	return []byte(strings.TrimSpace(string(raw)))
}

func nonNull(raw json.RawMessage) json.RawMessage {
	if string(bytesTrim(raw)) == "null" {
		return nil
	}
	return raw
}

func currentIssue(state string, last *string, issues json.RawMessage) (string, json.RawMessage, bool) {
	if state != "queued" && state != "rejected" && state != "unknown" {
		return IssueAbsent, nil, false
	}
	var batch []json.RawMessage
	if err := json.Unmarshal(issues, &batch); err != nil {
		return IssueUndeterminable, nil, false
	}
	if last == nil {
		return IssueAbsent, nil, false
	}
	var matched json.RawMessage
	for _, raw := range batch {
		var head struct {
			Code         string `json:"code"`
			ResolvedAtMs *int64 `json:"resolvedAtMs"`
		}
		if err := json.Unmarshal(raw, &head); err != nil {
			return IssueUndeterminable, nil, false
		}
		if head.Code == *last && head.ResolvedAtMs == nil {
			matched = raw
		}
	}
	if matched == nil {
		return IssueAbsent, nil, false
	}
	return IssuePresent, matched, state == "rejected" && allowsResume(matched)
}

func allowsResume(raw json.RawMessage) bool {
	var head struct {
		Allowed []string `json:"allowedActions"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return false
	}
	for _, action := range head.Allowed {
		if action == "resume" {
			return true
		}
	}
	return false
}

func receiptOf(raw json.RawMessage) (string, json.RawMessage) {
	trimmed := bytesTrim(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return ReceiptAbsent, nil
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(trimmed, &fields) != nil || fields == nil {
		return ReceiptUnreadable, nil
	}
	for _, key := range []string{"batch_id", "item_count"} {
		value, present := fields[key]
		if !present || string(bytesTrim(value)) == "null" {
			return ReceiptUnreadable, nil
		}
	}
	for _, key := range []string{"batch_id", "response_body", "transport_error"} {
		if value, present := fields[key]; present && !receiptValue[string](value) {
			return ReceiptUnreadable, nil
		}
	}
	for _, key := range []string{"item_count", "http_status"} {
		if value, present := fields[key]; present && !receiptValue[int32](value) {
			return ReceiptUnreadable, nil
		}
	}
	for _, key := range []string{"received_at_ms", "task_id"} {
		if value, present := fields[key]; present && !receiptValue[int64](value) {
			return ReceiptUnreadable, nil
		}
	}
	// A newer writer may add fields. Keep its bytes after checking only the
	// declared required fields and types; a receipt never grants an action.
	return ReceiptValid, json.RawMessage(trimmed)
}

func receiptValue[T any](raw json.RawMessage) bool {
	var value *T // Optional declared fields may be null; required fields are checked above.
	return json.Unmarshal(raw, &value) == nil
}

// CancelMovesToCancelled is the HTTP CASE: only queued with a null external task id.
func CancelMovesToCancelled(state string, externalTaskID *string) bool {
	return state == "queued" && externalTaskID == nil
}

// ReleaseAllowed is the release UPDATE predicate, not an IntentTransition edge.
// superseded, reconciled, conflict, and operator_attested are not release sources.
func ReleaseAllowed(state string, claimLive, unfinishedJob bool) bool {
	return state == "unknown" && !claimLive && !unfinishedJob
}

// ProbeRefusal is the 409 that stops a manual probe before any Seller call.
// ok means the row is a stopped unknown with an offer and no live claim.
func ProbeRefusal(state, lastError, offer string, claimUntil *time.Time, now time.Time) (message string, conflict bool) {
	if state != "unknown" || lastError != ReconcileStillUnknown {
		return "只有自动核对停止后才能按货号再核对，本次不会重发", true
	}
	if strings.TrimSpace(offer) == "" {
		return "这条发送记录没有货号，无法核对", true
	}
	if claimUntil != nil && claimUntil.After(now) {
		return "正在按货号核对，请稍后再试", true
	}
	return "", false
}

// SortTimeColumn is updated_at unless stableOrder selects created_at.
func SortTimeColumn(stable bool) string {
	if stable {
		return "created_at"
	}
	return "updated_at"
}

// CursorMicros formats the page boundary the same way jobs do.
func CursorMicros(at time.Time) int64 {
	return at.UnixMicro()
}
