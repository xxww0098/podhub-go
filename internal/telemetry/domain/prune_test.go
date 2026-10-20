package domain

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestPruneRowSetMatchesRust(t *testing.T) {
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	older := 14 * 24 * time.Hour
	cutoff := now.Add(-older)
	rows := []struct {
		id, kind string
		at       time.Time
	}{
		{"e1", "desktop_error_log.v1", cutoff.Add(-time.Second)},
		{"e2", "desktop_error_log.v2", cutoff.Add(-time.Hour)},
		{"e3", "desktop_error_log.v3", cutoff.Add(-time.Minute)},
		{"e4", "desktop_error_log.v4", cutoff},
		{"ef", "error_feedback.v1", cutoff.Add(-time.Millisecond)},
		{"fresh", "desktop_error_log.v1", cutoff.Add(time.Nanosecond)},
		{"bill-ai", "billing.ai-token-usage.v1", cutoff.Add(-time.Hour)},
		{"bill-up", "billing.object-upload-usage.v1", cutoff.Add(-24 * time.Hour)},
		{"bill-edge", "billing.ai-token-usage.v1", cutoff},
		{"other", "error", cutoff.Add(-time.Hour)},
		{"other-edge", "error", cutoff},
	}
	var rust, goSet []string
	for _, row := range rows {
		if RustPruneDeletes(row.kind, row.at, now, older) {
			rust = append(rust, row.id)
		}
		if GoPruneDeletes(row.kind, row.at, now, older) {
			goSet = append(goSet, row.id)
		}
	}
	want := []string{"e1", "e2", "e3", "ef", "bill-ai", "bill-up", "other"}
	if strings.Join(goSet, ",") != strings.Join(want, ",") {
		t.Fatalf("go set %v", goSet)
	}
	if strings.Join(rust, ",") != strings.Join(want, ",") {
		t.Fatalf("rust set %v", rust)
	}
	for _, id := range []string{"e4", "fresh", "bill-edge", "other-edge"} {
		if contains(goSet, id) || contains(rust, id) {
			t.Fatalf("cutoff or fresh row %s deleted rust=%v go=%v", id, rust, goSet)
		}
	}
}

func TestPruneFunctionIsAgedDeleteForEveryKind(t *testing.T) {
	raw, err := os.ReadFile("../../../db/migrations/00300_error_digest.sql")
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	start := strings.Index(text, "FUNCTION public.prune_aged_inbox")
	end := strings.Index(text, "REVOKE ALL ON FUNCTION public.prune_aged_inbox")
	if start < 0 || end < start {
		t.Fatal("prune function missing")
	}
	body := text[start:end]
	if !strings.Contains(body, "received_at < clock_timestamp() - (older_seconds::text || ' seconds')::interval") {
		t.Fatal("age predicate missing")
	}
	if strings.Contains(body, "kind") || strings.Contains(body, "client_listing_logs") {
		t.Fatal("prune function filters kind or touches client logs")
	}
	for _, kind := range append(append([]string{}, ErrorClassKinds...), BillingClassKinds...) {
		if strings.Contains(body, kind) {
			t.Fatalf("function names kind %s", kind)
		}
	}
	if strings.Contains(text, "BYPASSRLS") && !strings.Contains(text, "NOBYPASSRLS") {
		t.Fatal("prune role bypasses RLS")
	}
	if strings.Contains(text, "GRANT DELETE") || strings.Contains(text, "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_inbox_events") {
		t.Fatal("migration grants inbox DELETE")
	}
	if !strings.Contains(text, "GRANT EXECUTE ON FUNCTION public.prune_aged_inbox(bigint) TO podhub_error_prune") {
		t.Fatal("execute grant missing")
	}
	if !strings.Contains(text, "REVOKE ALL ON FUNCTION public.prune_aged_inbox(bigint) FROM PUBLIC, podhub_app, podhub_worker") {
		t.Fatal("execute revoke missing")
	}
}

func contains(ids []string, id string) bool {
	for _, item := range ids {
		if item == id {
			return true
		}
	}
	return false
}
