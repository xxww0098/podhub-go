package service

import (
	"encoding/json"

	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
)

// ParseUsage reads a Chat Completions usage object.
// Cached tokens are the max of prompt_tokens_details.cached_tokens,
// prompt_cache_hit_tokens, and cache_read_input_tokens.
func ParseUsage(completion []byte) (billing.Usage, string, error) {
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
	return billing.Usage{
		PromptTokens:              uint64(body.Usage.PromptTokens),
		CompletionTokens:          uint64(body.Usage.CompletionTokens),
		CachedPromptTokens:        uint64(cached),
		ReasoningCompletionTokens: uint64(body.Usage.CompletionDetails.Reasoning),
	}, body.ID, nil
}
