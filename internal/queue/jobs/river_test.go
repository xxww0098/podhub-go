package jobs

import (
	"github.com/riverqueue/river"
	"testing"
)

func TestRuntimeConfigHasNoDDL(t *testing.T) {
	cfg := runtimeConfig(river.NewWorkers(), nil)
	// Exercise the pinned River library's own defaulting, not just our literal:
	// nil enables its daily index list; a non-nil empty list disables reindexing.
	resolved := cfg.WithDefaults()
	if resolved.ReindexerIndexNames == nil || len(resolved.ReindexerIndexNames) != 0 {
		t.Fatalf("runtime enables reindexing: %v", resolved.ReindexerIndexNames)
	}
	if len((&river.Config{}).WithDefaults().ReindexerIndexNames) == 0 {
		t.Fatal("control: River default indexes unexpectedly empty")
	}
	if resolved.Schema != "public" {
		t.Fatalf("runtime schema = %q", resolved.Schema)
	}
	if len(resolved.Queues) == 0 || resolved.Workers == nil {
		t.Fatal("runtime workers disabled")
	}
}
