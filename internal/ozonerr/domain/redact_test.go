package domain

import (
	"strings"
	"testing"
)

func TestRedactStripsFixtureAndKeepsSellerText(t *testing.T) {
	const fixture = "fixture-api-key-browser-direct"
	got := Redact("类目拒绝 " + fixture + " 请改密度")
	if strings.Contains(got, fixture) || strings.Contains(strings.ToLower(got), "api-key") {
		t.Fatalf("secret kept: %s", got)
	}
	if !strings.Contains(got, "类目拒绝") || !strings.Contains(got, "请改密度") || !strings.Contains(got, "[redacted]") {
		t.Fatalf("%s", got)
	}
}

func TestRedactMarkers(t *testing.T) {
	cases := []struct {
		in   string
		gone string
	}{
		{"Bearer fixture-api-key-browser-direct", "fixture-api-key"},
		{`{"api_key":"fixture-api-key-browser-direct"}`, "fixture-api-key"},
		{"sk-abcdefghijklmnopqrstuvwxyz", "sk-"},
		{"client-id: 12345", "client-id"},
		{"signature=abcDEF", "signature="},
		{"x-amz-credential=ASIA", "x-amz-"},
		{"Api-Key: fixture-api-key-browser-direct", "api-key"},
	}
	for _, tc := range cases {
		got := Redact(tc.in)
		if strings.Contains(strings.ToLower(got), tc.gone) {
			t.Fatalf("%q -> %q still has %s", tc.in, got, tc.gone)
		}
	}
	if Redact("") != "" || Redact("普通卖家文案") != "普通卖家文案" {
		t.Fatal("plain text")
	}
	long := strings.Repeat("错", MaxSample+20)
	if n := len([]rune(Redact(long))); n != MaxSample {
		t.Fatalf("runes %d", n)
	}
}
