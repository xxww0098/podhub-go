package llm

import (
	"context"
	"testing"
)

func TestAcceptChatKeepsRelayKitOnTheStampedBody(t *testing.T) {
	service := Default()
	stamped := []byte(`{"model":"parity-model","messages":[{"role":"user","content":"hi"}]}`)
	if err := service.AcceptChat(context.Background(), stamped, "parity-model"); err != nil {
		t.Fatal(err)
	}
	completion := []byte(`{"id":"c1","model":"parity-model","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)
	if err := service.AcceptCompletion(context.Background(), completion, "parity-model"); err != nil {
		t.Fatal(err)
	}
}
