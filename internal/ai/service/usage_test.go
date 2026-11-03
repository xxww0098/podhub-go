package service

import (
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/aiclient"
)

func TestParseUsageReadsEachNativeShape(t *testing.T) {
	chat := `{"id":"c1","usage":{"prompt_tokens":100,"completion_tokens":40,"prompt_tokens_details":{"cached_tokens":30},"completion_tokens_details":{"reasoning_tokens":10}}}`
	usage, id, err := ParseUsage(aiclient.ChatCompletions, []byte(chat))
	if err != nil || id != "c1" || usage.PromptTokens != 100 || usage.CompletionTokens != 40 || usage.CachedPromptTokens != 30 || usage.ReasoningCompletionTokens != 10 {
		t.Fatalf("chat %+v %q %v", usage, id, err)
	}

	anthropic := `{"id":"m1","usage":{"input_tokens":20,"cache_creation_input_tokens":5,"cache_read_input_tokens":7,"output_tokens":9}}`
	usage, id, err = ParseUsage(aiclient.AnthropicMessages, []byte(anthropic))
	if err != nil || id != "m1" || usage.PromptTokens != 32 || usage.CachedPromptTokens != 7 || usage.CompletionTokens != 9 || usage.ReasoningCompletionTokens != 0 {
		t.Fatalf("anthropic %+v %q %v", usage, id, err)
	}

	responses := `{"id":"r1","usage":{"input_tokens":50,"input_tokens_details":{"cached_tokens":8},"output_tokens":11,"output_tokens_details":{"reasoning_tokens":4}}}`
	usage, id, err = ParseUsage(aiclient.Responses, []byte(responses))
	if err != nil || id != "r1" || usage.PromptTokens != 50 || usage.CachedPromptTokens != 8 || usage.CompletionTokens != 11 || usage.ReasoningCompletionTokens != 4 {
		t.Fatalf("responses %+v %q %v", usage, id, err)
	}
}

func TestParseUsageRejectsMissingAndInconsistentUsage(t *testing.T) {
	for _, tc := range []struct {
		format aiclient.Format
		body   string
	}{
		{aiclient.ChatCompletions, `{"id":"x"}`},
		{aiclient.ChatCompletions, `{"usage":{"prompt_tokens":1,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":2}}}`},
		{aiclient.AnthropicMessages, `{"usage":{"input_tokens":-1,"output_tokens":1}}`},
		{aiclient.Responses, `{"usage":{"input_tokens":1,"output_tokens":1,"output_tokens_details":{"reasoning_tokens":2}}}`},
		{aiclient.Format("unknown"), `{"usage":{}}`},
	} {
		if _, _, err := ParseUsage(tc.format, []byte(tc.body)); err == nil {
			t.Fatalf("%s accepted %s", tc.format, tc.body)
		}
	}
}
