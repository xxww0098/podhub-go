package db

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/pressly/goose/v3"

	"github.com/xxww0098/podhub-go/db"
)

const (
	// baselineMax is the highest goose version already merged when this guard
	// was added. 00330–00332 and 00335–00337 are lower and are already listed;
	// allow-missing replays those gaps from the embedded files. A file that
	// is not in db/migrations.sha256 is new and must use a greater version.
	// Do not raise this constant to admit a gap.
	baselineMax int64 = 341
	// baselineCount is how many migration files use a version at or below
	// baselineMax. Another file in that range fails even if its hash is
	// appended to the manifest.
	baselineCount = 313
)

// TestMigrationGuard freezes the bytes of merged goose files and refuses a
// new file whose version is not above the baseline max. It does not run
// goose, so it does not care which versions a database has already applied.
func TestMigrationGuard(t *testing.T) {
	manifest := readMigrationManifest(t)
	entries, err := fs.ReadDir(dbschema.Migrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}

	listedBelow := 0
	for name := range manifest {
		version, err := goose.NumericComponent(name)
		if err != nil {
			t.Errorf("manifest name %s: %v", name, err)
			continue
		}
		if version <= baselineMax {
			listedBelow++
		}
	}
	if listedBelow != baselineCount {
		t.Errorf("manifest lists %d files at or below %d, baseline is %d", listedBelow, baselineMax, baselineCount)
	}

	seen := map[int64]string{}
	atOrBelow := 0
	var highestBaseline int64
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() {
			t.Errorf("migrations contains a directory: %s", name)
			continue
		}
		version, err := goose.NumericComponent(name)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if prev, ok := seen[version]; ok {
			t.Errorf("duplicate migration version %d: %s and %s", version, prev, name)
		}
		seen[version] = name
		if version <= baselineMax {
			atOrBelow++
			if version > highestBaseline {
				highestBaseline = version
			}
		}
		body, err := fs.ReadFile(dbschema.Migrations, path.Join("migrations", name))
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		sum := sha256.Sum256(body)
		got := hex.EncodeToString(sum[:])
		want, ok := manifest[name]
		if !ok {
			if version <= baselineMax {
				t.Errorf("new migration %s version %d must be greater than baseline max %d", name, version, baselineMax)
			} else {
				t.Errorf("new migration %s is above baseline max %d; add its sha256 to db/migrations.sha256", name, baselineMax)
			}
			continue
		}
		if got != want {
			t.Errorf("migration %s sha256 changed", name)
		}
		delete(manifest, name)
	}
	for name := range manifest {
		t.Errorf("manifest lists %s but db/migrations has no such file", name)
	}
	if atOrBelow != baselineCount {
		t.Errorf("found %d migrations at or below %d, baseline is %d", atOrBelow, baselineMax, baselineCount)
	}
	if highestBaseline != baselineMax {
		t.Errorf("highest version at or below %d is %d", baselineMax, highestBaseline)
	}
}

func readMigrationManifest(t *testing.T) map[string]string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	manifestPath := filepath.Join(filepath.Dir(file), "..", "..", "..", "db", "migrations.sha256")
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		sum, name, found := strings.Cut(line, "  ")
		if !found || len(sum) != 64 || name == "" || strings.ContainsAny(name, " /") {
			t.Fatalf("bad manifest line: %q", line)
		}
		if _, dup := out[name]; dup {
			t.Fatalf("duplicate manifest entry %s", name)
		}
		out[name] = sum
	}
	if len(out) == 0 {
		t.Fatal("migration manifest is empty")
	}
	return out
}
