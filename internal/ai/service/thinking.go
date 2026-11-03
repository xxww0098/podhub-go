package service

import (
	"encoding/json"
	"errors"

	"github.com/xxww0098/podhub-go/internal/platform/aiclient"
)

// ApplyThinking writes the account's thinking policy into a native request.
// provider_default, none, and an empty policy leave the body unchanged. The
// account policy wins over a client field of the same name.
func ApplyThinking(format aiclient.Format, body []byte, thinking, thinkingFormat string) ([]byte, error) {
	if thinking == "" || thinking == "provider_default" || thinkingFormat == "" || thinkingFormat == "none" {
		return body, nil
	}
	var request map[string]json.RawMessage
	if err := json.Unmarshal(body, &request); err != nil || request == nil {
		return nil, errors.New("thinking request must be an object")
	}
	switch format {
	case aiclient.ChatCompletions:
		switch thinkingFormat {
		case "enable_thinking":
			request["enable_thinking"] = raw(thinking != "disabled")
		case "thinking_type":
			kind := "enabled"
			if thinking == "disabled" {
				kind = "disabled"
			}
			request["thinking"] = raw(map[string]string{"type": kind})
		case "reasoning_effort":
			effort := thinking
			if effort == "disabled" {
				effort = "minimal"
			}
			request["reasoning_effort"] = raw(effort)
		default:
			return nil, errors.New("thinking format is not valid for chat completions")
		}
	case aiclient.Responses:
		if thinkingFormat != "reasoning_effort" {
			return nil, errors.New("thinking format is not valid for responses")
		}
		if thinking == "disabled" {
			delete(request, "reasoning")
		} else {
			request["reasoning"] = raw(map[string]string{"effort": thinking})
		}
	case aiclient.AnthropicMessages:
		switch thinkingFormat {
		case "anthropic_budget":
			if thinking == "disabled" {
				request["thinking"] = raw(map[string]string{"type": "disabled"})
			} else {
				request["thinking"] = raw(map[string]any{"type": "enabled", "budget_tokens": budgetFor(thinking)})
			}
		case "anthropic_adaptive":
			kind := "adaptive"
			if thinking == "disabled" {
				kind = "disabled"
			}
			request["thinking"] = raw(map[string]string{"type": kind})
		default:
			return nil, errors.New("thinking format is not valid for anthropic messages")
		}
	default:
		return nil, errors.New("unsupported ai api format")
	}
	out, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	return out, nil
}

func budgetFor(thinking string) int {
	switch thinking {
	case "low":
		return 1024
	case "high":
		return 16_384
	default:
		return 4_096
	}
}

func raw(value any) json.RawMessage {
	out, _ := json.Marshal(value)
	return out
}
