package service

import (
	"bytes"
	"encoding/json"
	"math"
)

// EstimatePromptTokens is the pre-consume prompt count. The copied formula
// freezes prompt tokens times the model ratio; this process has no tokenizer,
// so the count is the rune length of message content divided by 4, rounding up.
// An empty body estimates 0, and the hold is then 0.
func EstimatePromptTokens(body []byte) int {
	var doc struct {
		Messages []struct {
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if json.Unmarshal(body, &doc) != nil {
		return 0
	}
	n := 0
	for _, message := range doc.Messages {
		n += contentRunes(message.Content)
	}
	if n == 0 {
		return 0
	}
	tokens := (n + 3) / 4
	if tokens > math.MaxInt32 {
		return math.MaxInt32
	}
	return tokens
}

func contentRunes(raw json.RawMessage) int {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return 0
	}
	if raw[0] == '"' {
		var text string
		if json.Unmarshal(raw, &text) == nil {
			return len([]rune(text))
		}
	}
	var parts []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		n := 0
		for _, part := range parts {
			n += len([]rune(part.Text))
		}
		return n
	}
	return 0
}
