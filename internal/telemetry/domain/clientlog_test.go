package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestClientLogKeepsCorrelationAndDropsSecrets(t *testing.T) {
	raw := []byte(`{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","ts":"2026-10-09T03:00:00Z","level":"info","module":"render","event":"render.end","sessionId":"11111111-2222-4333-8444-555555555555","version":"0.0.99","durationMs":42,"batchId":"BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB","offerId":"offer-1","fields":{"slices":3,"encodeMs":11,"presignMs":280,"putMs":6400,"completeMs":900,"concurrency":6,"effectiveType":"4g"}}`)
	now := time.Date(2026, 10, 9, 3, 0, 1, 0, time.UTC)
	got, ok := AcceptClientRecord(raw, now, "203.0.113.0/24")
	if !ok || got.ClientID != "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" || got.DurationMS == nil || *got.DurationMS != 42 {
		t.Fatalf("%+v %v", got, ok)
	}
	if !strings.Contains(got.Fields, `"slices":3`) || !strings.Contains(got.Fields, `"ipPrefix":"203.0.113.0/24"`) {
		t.Fatal(got.Fields)
	}
	if _, err := DecodeClientLogs([]byte(`{"records":[{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","ts":"2026-10-09T03:00:00Z","level":"info","module":"upload","event":"upload.end","sessionId":"11111111-2222-4333-8444-555555555555","version":"0.0.99","fields":{"ipPrefix":"203.0.113.0/24"}}]}`)); err == nil {
		t.Fatal("client ipPrefix must fail the body")
	}
}

func TestClientLogDropsAndWindowAndPrefix(t *testing.T) {
	now := time.Date(2026, 10, 9, 3, 0, 1, 0, time.UTC)
	stale := []byte(`{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","ts":"2026-01-01T00:00:00Z","level":"info","module":"render","event":"render.end","sessionId":"11111111-2222-4333-8444-555555555555","version":"0.0.99"}`)
	if _, ok := AcceptClientRecord(stale, now, ""); ok {
		t.Fatal("stale")
	}
	msg := "see https://secret.example/x and bearer abc token=1"
	raw := clientRecord(t, msg)
	got, ok := AcceptClientRecord(raw, now, "")
	if !ok || got.ErrorMessage == nil || strings.Contains(*got.ErrorMessage, "secret") || !strings.Contains(*got.ErrorMessage, "[omitted]") {
		t.Fatalf("%+v", got)
	}
	if IPPrefix([]string{"1.2.3.4, 203.0.113.8"}) != "203.0.113.0/24" {
		t.Fatal(IPPrefix([]string{"1.2.3.4, 203.0.113.8"}))
	}
	if IPPrefix([]string{"127.0.0.1"}) != "" {
		t.Fatal("loopback")
	}
	if IPPrefix([]string{"2001:db8:85a3::8a2e:370:7334"}) != "2001:0db8:85a3::/48" {
		t.Fatal(IPPrefix([]string{"2001:db8:85a3::8a2e:370:7334"}))
	}
	if IPPrefix([]string{"::ffff:198.51.100.20"}) != "198.51.100.0/24" {
		t.Fatal("mapped")
	}
	if IPPrefix([]string{"[2001:db8:1::5]:443"}) != "2001:0db8:0001::/48" {
		t.Fatal(IPPrefix([]string{"[2001:db8:1::5]:443"}))
	}
	var w LogWindow
	for i := 0; i < 30; i++ {
		if !w.Allow(7, 1000) {
			t.Fatal(i)
		}
	}
	if w.Allow(7, 1030) || !w.Allow(8, 1030) || !w.Allow(7, 1060) {
		t.Fatal("window")
	}
}

func clientRecord(t *testing.T, message string) json.RawMessage {
	t.Helper()
	body := map[string]any{
		"id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "ts": "2026-10-09T03:00:00Z",
		"level": "info", "module": "render", "event": "render.end",
		"sessionId": "11111111-2222-4333-8444-555555555555", "version": "0.0.99",
		"errorMessage": message,
	}
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
