package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestCommittedWasmMatchesItsChecksum(t *testing.T) {
	sum := sha256.Sum256(embedded)
	got := hex.EncodeToString(sum[:])
	if want := manifestSHA256(t, "server/listing-core.wasm"); got != want {
		t.Fatalf("sha256 %s manifest %s", got, want)
	}
}

func TestWazeroFreezeMatchesNativeOracle(t *testing.T) {
	mod := open(t, embedded)
	assertFreezeOracle(t, mod)
}

func TestRebuiltListingCoreWasmMatchesNativeOracle(t *testing.T) {
	raw, err := readListingCoreWasm()
	if err != nil {
		t.Fatal(err)
	}
	if raw == nil {
		t.Skip("LISTING_CORE_WASM is unset")
	}
	mod := open(t, raw)
	assertFreezeOracle(t, mod)
}

func TestListingCoreWasmEnvResolvesFromModuleRoot(t *testing.T) {
	t.Setenv("LISTING_CORE_WASM", "internal/listing/core/testdata/freeze_oracle.json")
	raw, err := readListingCoreWasm()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte(`"golden-freeze"`)) {
		t.Fatalf("oracle not read from module root, %d bytes", len(raw))
	}
}

// readListingCoreWasm opens LISTING_CORE_WASM. go test's working directory is
// the package directory, so a repo-relative path is also tried from the
// module root, the same way internal/listing reads LISTING_TAGS_WASM.
func readListingCoreWasm() ([]byte, error) {
	path := os.Getenv("LISTING_CORE_WASM")
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err == nil || filepath.IsAbs(path) {
		return data, err
	}
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return nil, err
	}
	rooted := filepath.Join(filepath.Dir(file), "..", "..", "..", path)
	data, rootedErr := os.ReadFile(rooted)
	if rootedErr != nil {
		return nil, err
	}
	return data, nil
}

func open(t *testing.T, wasm []byte) *Module {
	t.Helper()
	mod, err := Open(context.Background(), wasm)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = mod.Close(context.Background()) })
	return mod
}

func assertFreezeOracle(t *testing.T, mod *Module) {
	t.Helper()
	raw, err := os.ReadFile("testdata/freeze_oracle.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Name   string `json:"name"`
			Op     uint32 `json:"op"`
			Schema string `json:"schema"`
			Body   string `json:"body"`
			Result string `json:"result"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) < 3 {
		t.Fatalf("cases %d", len(file.Cases))
	}
	ctx := context.Background()
	for _, cse := range file.Cases {
		got, err := mod.Call(ctx, cse.Op, []byte(cse.Schema), []byte(cse.Body))
		if err != nil {
			t.Fatalf("%s: %v", cse.Name, err)
		}
		if string(got) != cse.Result {
			t.Fatalf("%s bytes differ\n got %s\nwant %s", cse.Name, got, cse.Result)
		}
		if cse.Name == "golden-freeze" && !json.Valid(got) {
			t.Fatal("golden")
		}
	}
}
