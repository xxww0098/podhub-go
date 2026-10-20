package wasm

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// glueDir is the wasm-bindgen bundle for the threaded renderer. Its wasm, JS,
// .d.ts and snippets are produced by one build and delivered together, so the
// manifest pins the directory as a whole (web_glue_sha256) instead of giving
// each file its own key. scripts/check-wasm-dist.sh recomputes that digest.
const glueDir = "browser/render/threaded"

// TestDistMatchesManifest walks dist/ recursively and compares every committed
// .wasm with the sha256 SOURCES.sha256 pins for its dist-relative path. The
// manifest keys carry their directory prefix (server/, browser/, test/), so a
// module that moved between groups must be re-pinned, and a module that is
// dropped from the manifest is caught here instead of by a silent loader.
func TestDistMatchesManifest(t *testing.T) {
	pinned := manifestWasm(t)
	onDisk := distWasm(t)

	// Both loops report, so one run lists every module that drifted.
	for rel, sum := range onDisk {
		want, ok := pinned[rel]
		if !ok {
			t.Errorf("%s is in dist but SOURCES.sha256 does not pin it", rel)
			continue
		}
		if sum != want {
			t.Errorf("%s sha256 %s manifest %s", rel, sum, want)
		}
	}
	for rel := range pinned {
		if _, ok := onDisk[rel]; !ok {
			t.Errorf("%s is pinned by SOURCES.sha256 but missing from dist", rel)
		}
	}

	// The threaded bundle has no per-file key, so require the digest that
	// covers it whenever the bundle is committed.
	if _, err := os.Stat(filepath.Join("dist", filepath.FromSlash(glueDir))); err == nil {
		if !isSHA256(manifestValue(t, "web_glue_sha256")) {
			t.Errorf("dist/%s is committed but SOURCES.sha256 has no web_glue_sha256", glueDir)
		}
	}

	// The embedded bytes are the committed bytes. go:embed cannot see files
	// outside this package, so this is the only place the copy is checked.
	embedded := map[string][]byte{
		"server/listing-tags.wasm": ListingTags,
		"server/listing-core.wasm": ListingCore,
	}
	for rel, data := range embedded {
		disk, err := os.ReadFile(filepath.Join("dist", filepath.FromSlash(rel)))
		if err != nil {
			t.Errorf("%s: %v", rel, err)
			continue
		}
		if !bytes.Equal(data, disk) {
			t.Errorf("embedded %s differs from dist", rel)
		}
	}
}

// manifestWasm returns the dist-relative .wasm paths SOURCES.sha256 pins, each
// mapped to its sha256. Lines are space separated; "#" starts a comment. Only
// .wasm keys with a 64-character hex value are modules, so toolchain and
// source fingerprints are skipped.
func manifestWasm(t *testing.T) map[string]string {
	t.Helper()
	raw, err := os.ReadFile("dist/SOURCES.sha256")
	if err != nil {
		t.Fatal(err)
	}
	pinned := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 || !strings.HasSuffix(fields[0], ".wasm") || !isSHA256(fields[1]) {
			continue
		}
		pinned[fields[0]] = fields[1]
	}
	if len(pinned) == 0 {
		t.Fatal("SOURCES.sha256 pins no .wasm module")
	}
	return pinned
}

// distWasm maps every .wasm under dist/, relative to dist and slash separated,
// to its sha256. The threaded glue bundle is skipped: it is pinned as one
// directory digest, and its internal layout belongs to wasm-bindgen.
func distWasm(t *testing.T) map[string]string {
	t.Helper()
	found := map[string]string{}
	err := filepath.WalkDir("dist", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".wasm") {
			return nil
		}
		rel, err := filepath.Rel("dist", path)
		if err != nil {
			return err
		}
		slashRel := filepath.ToSlash(rel)
		if slashRel == glueDir || strings.HasPrefix(slashRel, glueDir+"/") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		found[slashRel] = hex.EncodeToString(sum[:])
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(found) == 0 {
		t.Fatal("dist has no .wasm module")
	}
	return found
}

// manifestValue returns the second field of the manifest line whose key is
// key, or "" when the manifest has no such line.
func manifestValue(t *testing.T, key string) string {
	t.Helper()
	raw, err := os.ReadFile("dist/SOURCES.sha256")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if fields := strings.Fields(line); len(fields) == 2 && fields[0] == key {
			return fields[1]
		}
	}
	return ""
}

func isSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
