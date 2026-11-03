package app

import (
	"encoding/json"
	"testing"
)

func TestOCRAccountThinkingControlsProviderRequest(t *testing.T) {
	body := []byte(`{"model":"qwen3.7-flash","max_tokens":2048,"messages":[{"role":"user","content":"visible image only"}]}`)
	for _, tc := range []struct {
		thinking, format string
		want             string
	}{
		{"disabled", "enable_thinking", "false"},
		{"low", "enable_thinking", "true"},
		{"high", "enable_thinking", "true"},
		{"provider_default", "enable_thinking", ""},
		{"", "enable_thinking", ""},
		{"disabled", "none", ""},
		{"low", "reasoning_effort", ""},
		{"disabled", "thinking_type", ""},
	} {
		t.Run(tc.thinking+"_"+tc.format, func(t *testing.T) {
			got, err := ocrThinkingBody(body, tc.thinking, tc.format)
			if err != nil {
				t.Fatal(err)
			}
			var fields, original map[string]json.RawMessage
			if json.Unmarshal(got, &fields) != nil || json.Unmarshal(body, &original) != nil {
				t.Fatal("invalid JSON")
			}
			if string(fields["enable_thinking"]) != tc.want {
				t.Fatalf("provider switch %s; want %s", fields["enable_thinking"], tc.want)
			}
			for _, key := range []string{"model", "max_tokens", "messages"} {
				if string(fields[key]) != string(original[key]) {
					t.Fatalf("provider request changed %s", key)
				}
			}
		})
	}
	forced, err := ocrThinkingBody([]byte(`{"enable_thinking":true}`), "disabled", "enable_thinking")
	if err != nil || string(forced) != `{"enable_thinking":false}` {
		t.Fatalf("configured disabled was overridden: %s %v", forced, err)
	}
	for _, invalid := range []string{`null`, `[]`, `{`} {
		if _, err := ocrThinkingBody([]byte(invalid), "disabled", "enable_thinking"); err == nil {
			t.Fatalf("invalid recognition request accepted: %s", invalid)
		}
	}
}
