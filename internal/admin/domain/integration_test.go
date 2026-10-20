package domain

import "testing"

func TestThinkingAndSliceRoster(t *testing.T) {
	if ThinkingOK("chat_completions", "provider_default", "none") != "" {
		t.Fatal("default")
	}
	if ThinkingOK("chat_completions", "low", "none") == "" {
		t.Fatal("none")
	}
	if ThinkingOK("responses", "low", "enable_thinking") == "" || ThinkingOK("anthropic_messages", "low", "reasoning_effort") == "" {
		t.Fatal("incompatible")
	}
	if ThinkingOK("chat_completions", "high", "thinking_type") == "" {
		t.Fatal("thinking type")
	}
	if ThinkingOK("chat_completions", "low", "reasoning_effort") != "" {
		t.Fatal("chat ok")
	}
	msg := SliceBucket([]MediaAccount{{Bucket: "podhub-slices-apac-test"}}, false)
	if msg == "" {
		t.Fatal("speed")
	}
	msg = SliceBucket([]MediaAccount{{ID: "a", Bucket: "podhub-slices-apac", Active: false, PublicBaseURL: "https://podhub-slices-apac.ozon-pod.com"}}, false)
	if msg == "" {
		t.Fatal("active")
	}
	if SliceBucket([]MediaAccount{{ID: "podhub-slices", Bucket: "other", PreviousOrigin: "https://old.example"}}, true) == "" {
		t.Fatal("europe")
	}
	if SameBucket(&BucketKey{"cloudflare", "https://x", "b"}, nil, []BucketKey{{"cloudflare", "https://x", "b"}}) == "" {
		t.Fatal("share")
	}
	if !AIID("acc_1") || AIID("has space") || AIID("") {
		t.Fatal("id")
	}
	if !DissolveName("工作空间") || DissolveName("") || DissolveName(string(make([]rune, 65))) {
		t.Fatal("name")
	}
	if !DissolveUUID("11111111-1111-4111-8111-111111111111") || DissolveUUID("not-a-uuid") || DissolveUUID("  ") {
		t.Fatal("uuid")
	}
}
