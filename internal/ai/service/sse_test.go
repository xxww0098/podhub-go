package service

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestKeyMatchesRustCharset(t *testing.T) {
	if got, ok := Key("  abc-DEF_1:.  "); !ok || got != "abc-DEF_1:." {
		t.Fatalf("key %q %v", got, ok)
	}
	for _, raw := range []string{"", " ", "bad key", "a/b", strings.Repeat("a", 513)} {
		if _, ok := Key(raw); ok {
			t.Fatalf("accepted %q", raw)
		}
	}
}

func TestFoldSSEMatchesGateway(t *testing.T) {
	object := []byte(`{"id":"c1","usage":{"prompt_tokens":3},"choices":[{"message":{"content":"kept"}}]}`)
	got, err := FoldCompletion(object)
	if err != nil || string(got) != string(object) {
		t.Fatalf("object %s %v", got, err)
	}
	sse := strings.Join([]string{
		"data: {\"id\":\"cmpl\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}",
		"",
		"data: {\"choices\":[{\"delta\":{\"content\":\"lo\",\"reasoning\":\"r1\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}",
		"data: [DONE]",
	}, "\n")
	got, err = FoldCompletion([]byte(sse))
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Choices []struct {
			Finish  string `json:"finish_reason"`
			Message struct {
				Content   string `json:"content"`
				Reasoning string `json:"reasoning_content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			Prompt int `json:"prompt_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(got, &body); err != nil {
		t.Fatal(err)
	}
	if body.ID != "cmpl" || body.Model != "m" || body.Choices[0].Message.Content != "hello" || body.Choices[0].Message.Reasoning != "r1" || body.Choices[0].Finish != "stop" || body.Usage.Prompt != 2 {
		t.Fatalf("%s", got)
	}
	if _, err := FoldCompletion([]byte("data: [1]\n")); err == nil {
		t.Fatal("non-object chunk")
	}
	if _, err := FoldCompletion([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n")); err == nil {
		t.Fatal("missing usage")
	}
}

func TestStampRejectsStreamAfterShape(t *testing.T) {
	got, err := Stamp([]byte(`{"model":"client","n":1}`), "upstream")
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	if err := json.Unmarshal(got, &object); err != nil {
		t.Fatal(err)
	}
	if object["stream"] != false || object["model"] != "upstream" {
		t.Fatalf("%s", got)
	}
	if _, err := Stamp([]byte(`{"stream":true}`), "m"); err != errStreaming {
		t.Fatal(err)
	}
	if _, err := Stamp([]byte(`{"stream":"yes"}`), "m"); err != errInvalid {
		t.Fatal(err)
	}
}
