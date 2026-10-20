package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestBrowserStateWasmFreezeAndTransitions(t *testing.T) {
	raw := readStateWasm(t)
	mod, err := OpenBrowser(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = mod.Close(context.Background()) })
	ctx := context.Background()
	if mod.HasExport(ctx, "snapshot_from_fields") {
		t.Fatal("browser wasm exports snapshot_from_fields")
	}
	if !mod.HasExport(ctx, "send_transition") {
		t.Fatal("browser wasm missing send_transition")
	}
	// Server Open must refuse this browser module. It does not export
	// snapshot_from_fields. A compile-only Open used to return success and
	// notice the missing export only on the first instantiate.
	if _, err := Open(ctx, raw); err == nil {
		t.Fatal("server Open accepted a module without snapshot_from_fields")
	}
	assertFreezeOracle(t, mod)
	for _, row := range sendTable {
		gotState, allow, err := mod.SendTransition(ctx, row.state, row.event)
		if row.next == "" {
			if err == nil {
				t.Fatalf("%s %s accepted", row.state, row.event)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s %s: %v", row.state, row.event, err)
		}
		if gotState != row.next || allow != row.allow {
			t.Fatalf("%s %s -> %s %v, want %s %v", row.state, row.event, gotState, allow, row.next, row.allow)
		}
		if row.state == "fetch_started" || row.next == "fetch_started" || row.next == "submitting" || row.next == "unknown" || row.next == "accepted" {
			if allow {
				t.Fatalf("%s %s allowPost", row.state, row.event)
			}
		}
	}
	state, allow, err := mod.SendTransition(ctx, "queued", "key_present")
	if err != nil || state != "queued" || !allow {
		t.Fatalf("arm %s %v %v", state, allow, err)
	}
	state, allow, err = mod.SendTransition(ctx, state, "fetch_started")
	if err != nil || state != "fetch_started" || allow {
		t.Fatalf("start %s %v %v", state, allow, err)
	}
	_, allow, err = mod.SendTransition(ctx, "fetch_started", "key_present")
	if err != nil || allow {
		t.Fatal("fetch_started re-armed")
	}
	for _, state := range []string{"submitting", "unknown", "accepted", "rejected"} {
		_, allow, err = mod.SendTransition(ctx, state, "key_present")
		if err != nil || allow {
			t.Fatalf("%s re-armed %v", state, err)
		}
	}
}

func TestCommittedBrowserWasmChecksum(t *testing.T) {
	raw := committedStateWasm(t)
	sum := sha256.Sum256(raw)
	got := hex.EncodeToString(sum[:])
	if want := manifestSHA256(t, "browser/listing-state.wasm"); got != want {
		t.Fatalf("sha256 %s manifest %s", got, want)
	}
}

func readStateWasm(t *testing.T) []byte {
	t.Helper()
	path := os.Getenv("LISTING_STATE_WASM")
	if path == "" {
		return committedStateWasm(t)
	}
	data, err := os.ReadFile(path)
	if err == nil || filepath.IsAbs(path) {
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal(err)
	}
	rooted := filepath.Join(filepath.Dir(file), "..", "..", "..", path)
	data, rootedErr := os.ReadFile(rooted)
	if rootedErr != nil {
		t.Fatal(err)
	}
	return data
}

func committedStateWasm(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile(distPath(t, "listing-state.wasm"))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// distRoot is the committed wasm/dist tree.
func distRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("caller")
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "wasm", "dist")
}

// distPath is a committed browser module, relative to wasm/dist/browser/.
func distPath(t *testing.T, name string) string {
	t.Helper()
	return filepath.Join(distRoot(t), "browser", name)
}

// manifestSHA256 is the sha256 that wasm/dist/SOURCES.sha256 records for key.
// Keys are dist-relative, so they carry their group prefix, e.g.
// browser/listing-state.wasm.
func manifestSHA256(t *testing.T, key string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(distRoot(t), "SOURCES.sha256"))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == key && len(fields[1]) == 64 {
			return fields[1]
		}
	}
	t.Fatalf("%s is not in SOURCES.sha256", key)
	return ""
}

type sendEdge struct {
	state, event, next string
	allow              bool
}

// sendTable is the named browser send table. An empty next is illegal.
// allowPost is true only for queued + key_present.
var sendTable = []sendEdge{
	{"queued", "key_present", "queued", true},
	{"queued", "fetch_started", "fetch_started", false},
	{"queued", "task_accepted", "", false},
	{"queued", "http_4xx", "", false},
	{"queued", "no_status", "", false},
	{"queued", "report_failed", "", false},

	{"submitting", "key_present", "submitting", false},
	{"submitting", "fetch_started", "fetch_started", false},
	{"submitting", "task_accepted", "accepted", false},
	{"submitting", "http_4xx", "rejected", false},
	{"submitting", "no_status", "unknown", false},
	{"submitting", "report_failed", "submitting", false},

	{"fetch_started", "key_present", "fetch_started", false},
	{"fetch_started", "fetch_started", "fetch_started", false},
	{"fetch_started", "task_accepted", "accepted", false},
	{"fetch_started", "http_4xx", "rejected", false},
	{"fetch_started", "no_status", "unknown", false},
	{"fetch_started", "report_failed", "submitting", false},

	{"unknown", "key_present", "unknown", false},
	{"unknown", "fetch_started", "", false},
	{"unknown", "task_accepted", "accepted", false},
	{"unknown", "http_4xx", "rejected", false},
	{"unknown", "no_status", "unknown", false},
	{"unknown", "report_failed", "unknown", false},

	{"accepted", "key_present", "accepted", false},
	{"accepted", "fetch_started", "", false},
	{"accepted", "task_accepted", "accepted", false},
	{"accepted", "http_4xx", "", false},
	{"accepted", "no_status", "", false},
	{"accepted", "report_failed", "", false},

	{"rejected", "key_present", "rejected", false},
	{"rejected", "fetch_started", "", false},
	{"rejected", "task_accepted", "", false},
	{"rejected", "http_4xx", "rejected", false},
	{"rejected", "no_status", "", false},
	{"rejected", "report_failed", "", false},

	{"nope", "key_present", "", false},
	{"fetch_started", "bogus", "", false},
}
