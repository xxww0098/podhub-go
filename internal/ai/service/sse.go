package service

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// FoldCompletion returns one Chat Completions object.
// A JSON object is kept. Anything else is folded from SSE data lines.
// A chunk that is not a JSON object fails the body. Missing usage fails the fold.
func FoldCompletion(body []byte) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) > 0 && trimmed[0] == '{' {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(trimmed, &object); err == nil {
			return append(json.RawMessage(nil), trimmed...), nil
		}
	}
	text := string(body)
	if !utf8OK(body) {
		return nil, errInvalid
	}
	var content, reasoning, id, model, finish string
	var usage json.RawMessage
	saw := false
	for _, line := range strings.Split(text, "\n") {
		payload := strings.TrimSpace(line)
		if !strings.HasPrefix(payload, "data:") {
			continue
		}
		payload = strings.TrimSpace(strings.TrimPrefix(payload, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var chunk map[string]any
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			return nil, errInvalid
		}
		saw = true
		if value, ok := chunk["id"].(string); ok && value != "" {
			id = value
		}
		if value, ok := chunk["model"].(string); ok && value != "" {
			model = value
		}
		if raw, ok := chunk["usage"].(map[string]any); ok {
			encoded, err := json.Marshal(raw)
			if err != nil {
				return nil, errInvalid
			}
			usage = encoded
		}
		choices, _ := chunk["choices"].([]any)
		if len(choices) == 0 {
			continue
		}
		choice, _ := choices[0].(map[string]any)
		if choice == nil {
			return nil, errInvalid
		}
		if value, ok := choice["finish_reason"].(string); ok && value != "" {
			finish = value
		}
		if delta, ok := choice["delta"].(map[string]any); ok {
			content += textField(delta["content"])
			reasoning += firstText(delta["reasoning_content"], delta["reasoning"])
		}
		if message, ok := choice["message"].(map[string]any); ok {
			content += textField(message["content"])
			reasoning += firstText(message["reasoning_content"], message["reasoning"])
		}
	}
	if !saw || len(usage) == 0 {
		return nil, errInvalid
	}
	out, err := json.Marshal(map[string]any{
		"id": id, "model": model,
		"choices": []any{map[string]any{
			"index": 0, "finish_reason": finish,
			"message": map[string]any{"role": "assistant", "content": content, "reasoning_content": reasoning},
		}},
		"usage": json.RawMessage(usage),
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func textField(value any) string {
	text, _ := value.(string)
	return text
}

func firstText(values ...any) string {
	for _, value := range values {
		if text, ok := value.(string); ok && text != "" {
			return text
		}
	}
	return ""
}

func utf8OK(body []byte) bool {
	return utf8.Valid(body)
}
