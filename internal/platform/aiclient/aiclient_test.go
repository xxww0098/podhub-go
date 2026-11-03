package aiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEndpointKeepsTheAccountRoot(t *testing.T) {
	for _, tc := range []struct {
		base, format, want string
	}{
		{"https://api.openai.com/v1", "chat_completions", "https://api.openai.com/v1/chat/completions"},
		{"https://api.openai.com/v1/", "responses", "https://api.openai.com/v1/responses"},
		{"https://api.anthropic.com", "anthropic_messages", "https://api.anthropic.com/v1/messages"},
		{"https://api.anthropic.com/v1", "anthropic_messages", "https://api.anthropic.com/v1/messages"},
		{"https://gateway.example/ai/v1", "chat_completions", "https://gateway.example/ai/v1/chat/completions"},
	} {
		got, err := Endpoint(tc.base, Format(tc.format))
		if err != nil || got != tc.want {
			t.Fatalf("%s %s: got %q err %v", tc.base, tc.format, got, err)
		}
	}
	for _, base := range []string{"", "ftp://example.com", "https://user@example.com/v1", "https://example.com/v1?x=1"} {
		if _, err := Endpoint(base, ChatCompletions); err == nil {
			t.Fatalf("accepted %q", base)
		}
	}
}

func TestSetAuthUsesTheNativeHeader(t *testing.T) {
	header := http.Header{}
	SetAuth(header, AnthropicMessages, "sk-ant")
	if header.Get("x-api-key") != "sk-ant" || header.Get("anthropic-version") != "2023-06-01" || header.Get("Authorization") != "" {
		t.Fatalf("anthropic %v", header)
	}
	header = http.Header{}
	SetAuth(header, ChatCompletions, "sk")
	if header.Get("Authorization") != "Bearer sk" || header.Get("x-api-key") != "" {
		t.Fatalf("chat %v", header)
	}
}

func TestStampRejectsStreamingAndKeepsNumbers(t *testing.T) {
	body, err := Stamp([]byte(`{"model":"client","seed":9007199254740993,"stream":false}`), "upstream", Responses)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&object); err != nil {
		t.Fatal(err)
	}
	if object["model"] != "upstream" || object["stream"] != false || object["seed"].(json.Number).String() != "9007199254740993" {
		t.Fatalf("%s", body)
	}
	if _, err := Stamp([]byte(`{"stream":true}`), "m", ChatCompletions); !errors.Is(err, ErrStreaming) {
		t.Fatalf("streaming err %v", err)
	}
	for _, invalid := range []string{`[]`, `{"stream":"yes"}`, `{"model":"a"}{"model":"b"}`, ``} {
		if _, err := Stamp([]byte(invalid), "m", ChatCompletions); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%q err %v", invalid, err)
		}
	}
}

func TestCompletePostsNativeShape(t *testing.T) {
	var gotPath, gotAuth, gotVersion, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.Path, r.Header.Get("x-api-key")
		gotVersion = r.Header.Get("anthropic-version")
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"slow"}`))
	}))
	defer srv.Close()
	status, raw, err := (Client{HTTP: srv.Client()}).Complete(context.Background(), Account{
		BaseURL: srv.URL + "/v1", APIKey: "k", Format: AnthropicMessages,
	}, []byte(`{"model":"m"}`))
	if err != nil || status != http.StatusTooManyRequests || string(raw) != `{"error":"slow"}` {
		t.Fatalf("status %d body %q err %v", status, raw, err)
	}
	if gotPath != "/v1/messages" || gotAuth != "k" || gotVersion != "2023-06-01" || gotBody != `{"model":"m"}` {
		t.Fatalf("path %q auth %q version %q body %q", gotPath, gotAuth, gotVersion, gotBody)
	}
}
