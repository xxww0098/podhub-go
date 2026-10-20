package telemetry

import (
	"os"
	"strings"
	"testing"
)

func TestClientLogPruneStatementUnchanged(t *testing.T) {
	if strings.Contains(clientLogPruneSQL, "level") || strings.Contains(clientLogPruneSQL, "kind") {
		t.Fatal(clientLogPruneSQL)
	}
	if !strings.Contains(clientLogPruneSQL, "DELETE FROM client_listing_logs") {
		t.Fatal(clientLogPruneSQL)
	}
	if !strings.Contains(clientLogPruneSQL, "received_at < clock_timestamp()") {
		t.Fatal(clientLogPruneSQL)
	}
}

func TestDigestSourcesDoNotReadSwitches(t *testing.T) {
	files := []string{
		"domain/redact.go", "domain/prune.go", "service/digest.go",
		"repo/digest.go", "jobs/digest.go", "retention.go",
	}
	for _, name := range files {
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		text := string(raw)
		for _, banned := range []string{"os.Getenv", "OZON_WRITE_KILL_SWITCH", "CLOUD_MEDIA_GC_DELETE"} {
			if strings.Contains(text, banned) {
				t.Fatalf("%s contains %s", name, banned)
			}
		}
	}
}

func TestInboxPruneGoesThroughFunction(t *testing.T) {
	raw, err := os.ReadFile("retention.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if strings.Contains(text, "DELETE FROM event_inbox_events") {
		t.Fatal("inbox prune still issues a table delete")
	}
	if !strings.Contains(text, "prune_aged_inbox") || !strings.Contains(text, pruneRole) {
		t.Fatal("restricted prune path missing")
	}
	for _, banned := range []string{"os.Getenv", "OZON_WRITE_KILL_SWITCH", "CLOUD_MEDIA_GC_DELETE"} {
		if strings.Contains(text, banned) {
			t.Fatal(banned)
		}
	}
}
