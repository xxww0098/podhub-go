package db

import (
	"io/fs"
	"testing"

	"github.com/pressly/goose/v3"

	"github.com/xxww0098/podhub-go/db"
)

// TestMigrationVersionsUnique rejects two files that share a goose version.
// Goose refuses the directory before Up runs, allow-missing or not.
func TestMigrationVersionsUnique(t *testing.T) {
	entries, err := fs.ReadDir(dbschema.Migrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[int64]string, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			t.Fatalf("migrations contains a directory: %s", entry.Name())
		}
		version, err := goose.NumericComponent(entry.Name())
		if err != nil {
			t.Fatalf("%s: %v", entry.Name(), err)
		}
		if prev, ok := seen[version]; ok {
			t.Fatalf("duplicate migration version %d: %s and %s", version, prev, entry.Name())
		}
		seen[version] = entry.Name()
	}
	if len(seen) == 0 {
		t.Fatal("no migrations")
	}
}
