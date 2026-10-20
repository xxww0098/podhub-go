package service

import "testing"

func TestEstimatePromptTokens(t *testing.T) {
	if got := EstimatePromptTokens([]byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`)); got != 1 {
		t.Fatalf("hi %d", got)
	}
	if got := EstimatePromptTokens([]byte(`{"messages":[]}`)); got != 0 {
		t.Fatalf("empty %d", got)
	}
	body := `{"messages":[{"content":[{"type":"text","text":"abcd"},{"type":"text","text":"ef"}]}]}`
	if got := EstimatePromptTokens([]byte(body)); got != 2 {
		t.Fatalf("parts %d", got)
	}
	wide := make([]byte, 3997)
	for i := range wide {
		wide[i] = 'x'
	}
	raw := append([]byte(`{"messages":[{"content":"`), wide...)
	raw = append(raw, []byte(`"}]}`)...)
	if got := EstimatePromptTokens(raw); got != 1000 {
		t.Fatalf("long %d", got)
	}
}
