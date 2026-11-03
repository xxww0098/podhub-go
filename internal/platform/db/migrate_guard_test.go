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
	// baselineMax is the highest version of the squashed baseline. Those three
	// files are the schema and seed every database already has, so they are
	// frozen; a new file must use a greater version.
	baselineMax int64 = 3
	// baselineCount is how many files use a version at or below baselineMax.
	// Another file in that range fails even if its hash is in the manifest.
	baselineCount = 3
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

// TestBaselineMaxMatchesFiles keeps squashedMax equal to the shipped baseline
// so the skip guard cannot drift from the directory it describes.
func TestBaselineMaxMatchesFiles(t *testing.T) {
	entries, err := fs.ReadDir(dbschema.Migrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	var baseline int64
	for _, entry := range entries {
		version, err := goose.NumericComponent(entry.Name())
		if err != nil {
			t.Fatalf("%s: %v", entry.Name(), err)
		}
		if version <= baselineMax && version > baseline {
			baseline = version
		}
	}
	if baseline != squashedMax {
		t.Fatalf("squashedMax is %d but the baseline ends at %d", squashedMax, baseline)
	}
	shipped, err := shippedVersions()
	if err != nil {
		t.Fatal(err)
	}
	var highest int64
	for _, version := range shipped {
		if version > highest {
			highest = version
		}
	}
	if highest < squashedMax {
		t.Fatalf("the shipped directory ends at %d, below the baseline %d", highest, squashedMax)
	}
}

// TestSquashedHistoryGuard pins the cases that matter. A database from the
// 329-file chain (version 368) keeps working while nothing new is shipped, a
// squashed database that has applied a later file is not refused on the next
// run, and an old-chain database is refused once a migration is added.
func TestSquashedHistoryGuard(t *testing.T) {
	shipped, err := shippedVersions()
	if err != nil {
		t.Fatal(err)
	}
	// With only the baseline shipped, an old-chain database is at head.
	baseline := []int64{1, 2, 3}
	oldChain := map[int64]bool{368: true}
	for _, version := range baseline {
		oldChain[version] = true
	}
	if version, refused := foreignApplied(oldChain, baseline); refused {
		t.Fatalf("an old-chain database at head must still start, refused on %d", version)
	}

	// A database that applied this build's files is never refused.
	squashed := map[int64]bool{}
	for _, version := range shipped {
		squashed[version] = true
	}
	if version, refused := foreignApplied(squashed, shipped); refused {
		t.Fatalf("a squashed database must not be refused, refused on %d", version)
	}

	// Once a file is added, the old chain would silently skip it.
	withNew := append(append([]int64{}, baseline...), squashedMax+1)
	version, refused := foreignApplied(oldChain, withNew)
	if !refused {
		t.Fatal("an old-chain database must be refused once a migration is added")
	}
	if version != 368 {
		t.Fatalf("refusal must name the old chain's highest version, got %d", version)
	}

	// A fresh database is never refused, whatever is shipped.
	if version, refused := foreignApplied(map[int64]bool{}, withNew); refused {
		t.Fatalf("a fresh database must not be refused, refused on %d", version)
	}
}
