package api

import "encoding/json"

type adminErrorBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

type telemetryErrorBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

type listingErrorBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

type bannedRuleWire struct {
	Term      string `json:"term"`
	MatchMode string `json:"matchMode"`
}

type bannedRulesWire struct {
	Rules []bannedRuleWire `json:"rules"`
}

type bannedRulesResponse struct {
	Data bannedRulesWire `json:"data"`
}

type bannedTagWire struct {
	ID        int64  `json:"id"`
	Term      string `json:"term"`
	MatchMode string `json:"matchMode"`
	Note      string `json:"note"`
	CreatedBy string `json:"createdBy"`
	CreatedAt string `json:"createdAt"`
	Enabled   bool   `json:"enabled"`
}

type bannedTagsWire struct {
	Tags []bannedTagWire `json:"tags"`
}

type bannedTagsResponse struct {
	Data bannedTagsWire `json:"data"`
}

type usageMetricWire struct {
	Metric       string `json:"metric"`
	Unit         string `json:"unit"`
	Verification string `json:"verification"`
	Total        int64  `json:"total"`
}

type usageRequestWire struct {
	RequestID             string  `json:"request_id"`
	Model                 string  `json:"model"`
	Operation             string  `json:"operation"`
	Status                string  `json:"status"`
	InputTokens           int64   `json:"input_tokens"`
	OutputTokens          int64   `json:"output_tokens"`
	CachedInputTokens     int64   `json:"cached_input_tokens"`
	ReasoningOutputTokens int64   `json:"reasoning_output_tokens"`
	CacheHitRateBps       int32   `json:"cache_hit_rate_bps"`
	TotalMicrofen         int64   `json:"total_microfen"`
	ChargedMicrofen       int64   `json:"charged_microfen"`
	AbsorbedMicrofen      int64   `json:"absorbed_microfen"`
	ErrorClass            *string `json:"error_class,omitempty"`
	CreatedAt             string  `json:"created_at"`
	SettledAt             *string `json:"settled_at,omitempty"`
}

type usageStatsWire struct {
	Days              int32              `json:"days"`
	From              string             `json:"from"`
	To                string             `json:"to"`
	TotalTokens       int64              `json:"total_tokens"`
	InputTokens       int64              `json:"input_tokens"`
	OutputTokens      int64              `json:"output_tokens"`
	CachedInputTokens int64              `json:"cached_input_tokens"`
	MessageCount      int64              `json:"message_count"`
	CacheHitRateBps   int32              `json:"cache_hit_rate_bps"`
	TotalMicrofen     int64              `json:"total_microfen"`
	ChargedMicrofen   int64              `json:"charged_microfen"`
	AbsorbedMicrofen  int64              `json:"absorbed_microfen"`
	Page              int32              `json:"page"`
	PageSize          int32              `json:"page_size"`
	TotalPages        int32              `json:"total_pages"`
	Requests          []usageRequestWire `json:"requests"`
	Organization      []usageMetricWire  `json:"organization,omitempty"`
	Member            []usageMetricWire  `json:"member,omitempty"`
	GeneratedAtMs     int64              `json:"generated_at_ms"`
}

type usageStatsResponse struct {
	Data usageStatsWire `json:"data"`
}

type listingRunWire struct {
	ID             string          `json:"id"`
	Kind           string          `json:"kind"`
	AggregateType  string          `json:"aggregateType"`
	AggregateID    string          `json:"aggregateId"`
	InputRevision  int64           `json:"inputRevision"`
	State          string          `json:"state"`
	Attempt        int32           `json:"attempt"`
	LastErrorCode  *string         `json:"lastErrorCode,omitempty"`
	IdempotencyKey string          `json:"idempotencyKey"`
	Payload        json.RawMessage `json:"payload"`
	UpdatedAtMs    int64           `json:"updatedAtMs"`
}

type listingRunResponse struct {
	Data listingRunWire `json:"data"`
}

type listingRunsWire struct {
	Items      []listingRunWire `json:"items"`
	NextCursor *string          `json:"nextCursor,omitempty"`
}

type listingRunsResponse struct {
	Data listingRunsWire `json:"data"`
}
