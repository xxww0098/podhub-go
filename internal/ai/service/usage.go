package service

import (
	"encoding/json"

	"github.com/xxww0098/podhub-go/internal/platform/aiclient"

	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
)

// ParseUsage reads the usage object of one native response. The returned
// prompt and completion totals include their cached and reasoning subsets;
// Price.ChargeUsage subtracts them before applying the lane rates.
func ParseUsage(format aiclient.Format, completion []byte) (billing.Usage, string, error) {
	switch format {
	case aiclient.ChatCompletions:
		return parseChatUsage(completion)
	case aiclient.AnthropicMessages:
		return parseAnthropicUsage(completion)
	case aiclient.Responses:
		return parseResponsesUsage(completion)
	default:
		return billing.Usage{}, "", errInvalid
	}
}

// parseChatUsage reads a Chat Completions usage object.
// Cached tokens are the max of prompt_tokens_details.cached_tokens,
// prompt_cache_hit_tokens, and cache_read_input_tokens.
func parseChatUsage(completion []byte) (billing.Usage, string, error) {
	var body struct {
		ID    string `json:"id"`
		Usage *struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
			PromptCacheHit   int64 `json:"prompt_cache_hit_tokens"`
			CacheRead        int64 `json:"cache_read_input_tokens"`
			PromptDetails    struct {
				Cached int64 `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
			CompletionDetails struct {
				Reasoning int64 `json:"reasoning_tokens"`
			} `json:"completion_tokens_details"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(completion, &body); err != nil || body.Usage == nil {
		return billing.Usage{}, "", errInvalid
	}
	cached := body.Usage.PromptDetails.Cached
	if body.Usage.PromptCacheHit > cached {
		cached = body.Usage.PromptCacheHit
	}
	if body.Usage.CacheRead > cached {
		cached = body.Usage.CacheRead
	}
	if body.Usage.PromptTokens < 0 || body.Usage.CompletionTokens < 0 || cached < 0 || body.Usage.CompletionDetails.Reasoning < 0 {
		return billing.Usage{}, "", errInvalid
	}
	if cached > body.Usage.PromptTokens || body.Usage.CompletionDetails.Reasoning > body.Usage.CompletionTokens {
		return billing.Usage{}, "", errInvalid
	}
	return billing.Usage{
		PromptTokens:              uint64(body.Usage.PromptTokens),
		CompletionTokens:          uint64(body.Usage.CompletionTokens),
		CachedPromptTokens:        uint64(cached),
		ReasoningCompletionTokens: uint64(body.Usage.CompletionDetails.Reasoning),
	}, body.ID, nil
}

// parseAnthropicUsage reads a Messages usage object. Anthropic's input_tokens
// excludes both cache counters, so the prompt total is their sum. Cache writes
// are billed at the input rate; the schedule has no separate cache-write lane.
func parseAnthropicUsage(completion []byte) (billing.Usage, string, error) {
	var body struct {
		ID    string `json:"id"`
		Usage *struct {
			InputTokens         int64 `json:"input_tokens"`
			CacheCreationTokens int64 `json:"cache_creation_input_tokens"`
			CacheReadTokens     int64 `json:"cache_read_input_tokens"`
			OutputTokens        int64 `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(completion, &body); err != nil || body.Usage == nil {
		return billing.Usage{}, "", errInvalid
	}
	if body.Usage.InputTokens < 0 || body.Usage.CacheCreationTokens < 0 || body.Usage.CacheReadTokens < 0 || body.Usage.OutputTokens < 0 {
		return billing.Usage{}, "", errInvalid
	}
	prompt := body.Usage.InputTokens + body.Usage.CacheCreationTokens + body.Usage.CacheReadTokens
	if prompt < body.Usage.InputTokens {
		return billing.Usage{}, "", errInvalid
	}
	return billing.Usage{
		PromptTokens:       uint64(prompt),
		CachedPromptTokens: uint64(body.Usage.CacheReadTokens),
		CompletionTokens:   uint64(body.Usage.OutputTokens),
	}, body.ID, nil
}

// parseResponsesUsage reads an OpenAI Responses usage object. The output total
// includes reasoning tokens; the input total includes cached tokens.
func parseResponsesUsage(completion []byte) (billing.Usage, string, error) {
	var body struct {
		ID    string `json:"id"`
		Usage *struct {
			InputTokens  int64 `json:"input_tokens"`
			OutputTokens int64 `json:"output_tokens"`
			InputDetails struct {
				Cached int64 `json:"cached_tokens"`
			} `json:"input_tokens_details"`
			OutputDetails struct {
				Reasoning int64 `json:"reasoning_tokens"`
			} `json:"output_tokens_details"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(completion, &body); err != nil || body.Usage == nil {
		return billing.Usage{}, "", errInvalid
	}
	if body.Usage.InputTokens < 0 || body.Usage.OutputTokens < 0 || body.Usage.InputDetails.Cached < 0 || body.Usage.OutputDetails.Reasoning < 0 {
		return billing.Usage{}, "", errInvalid
	}
	if body.Usage.InputDetails.Cached > body.Usage.InputTokens || body.Usage.OutputDetails.Reasoning > body.Usage.OutputTokens {
		return billing.Usage{}, "", errInvalid
	}
	return billing.Usage{
		PromptTokens:              uint64(body.Usage.InputTokens),
		CachedPromptTokens:        uint64(body.Usage.InputDetails.Cached),
		CompletionTokens:          uint64(body.Usage.OutputTokens),
		ReasoningCompletionTokens: uint64(body.Usage.OutputDetails.Reasoning),
	}, body.ID, nil
}
