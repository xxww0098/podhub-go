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

// The baseline is a pg_dump of the head schema, so the prune function and its
// ACLs are recorded once, not in a numbered migration of their own.
const baselineSchema = "../../../db/migrations/00002_schema.sql"

func TestPruneFunctionIsAgedDeleteForEveryKind(t *testing.T) {
	raw, err := os.ReadFile(baselineSchema)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	start := strings.Index(text, "CREATE FUNCTION public.prune_aged_inbox")
	end := strings.Index(text[start:], "$$;")
	if start < 0 || end < 0 {
		t.Fatal("prune function missing")
	}
	body := text[start : start+end]
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
	if !strings.Contains(body, "SECURITY DEFINER") {
		t.Fatal("prune function must run as its owner")
	}
	if strings.Contains(text, "BYPASSRLS") && !strings.Contains(text, "NOBYPASSRLS") {
		t.Fatal("prune role bypasses RLS")
	}
	if strings.Contains(text, "GRANT DELETE ON TABLE public.event_inbox_events") ||
		strings.Contains(text, "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_inbox_events") {
		t.Fatal("schema grants inbox DELETE")
	}
	aclStart := strings.Index(text, "-- Name: FUNCTION prune_aged_inbox(older_seconds bigint); Type: ACL")
	if aclStart < 0 {
		t.Fatal("prune function ACL missing")
	}
	acl := text[aclStart:]
	if next := strings.Index(acl[len("-- Name:"):], "\n-- Name:"); next >= 0 {
		acl = acl[:next+len("-- Name:")]
	}
	if !strings.Contains(acl, "GRANT ALL ON FUNCTION public.prune_aged_inbox(older_seconds bigint) TO podhub_error_prune") {
		t.Fatal("execute grant missing")
	}
	for _, role := range []string{"podhub_app", "podhub_worker", "PUBLIC"} {
		if strings.Contains(acl, "TO "+role) {
			t.Fatalf("prune function granted to %s", role)
		}
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
