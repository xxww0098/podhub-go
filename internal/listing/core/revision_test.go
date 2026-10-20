package core

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestSameFieldsDifferentOrderSameRevision(t *testing.T) {
	mod := openEmbedded(t)
	colorThenSize := cacheInput(field("color", "20", false, "text", nil), field("size", "10", true, "text", nil))
	sizeThenColor := cacheInput(field("size", "10", true, "text", nil), field("color", "20", false, "text", nil))
	a := revisionOf(t, mod, colorThenSize)
	b := revisionOf(t, mod, sizeThenColor)
	if a != b {
		t.Fatalf("order changed the revision\n %s\n %s", a, b)
	}
	if !strings.HasPrefix(a, "workflow:sha256:") {
		t.Fatalf("revision %s", a)
	}
}

func TestDisplayOrderIsKeptWhenRevisionIgnoresOrder(t *testing.T) {
	mod := openEmbedded(t)
	raw := cacheInput(field("color", "20", false, "text", nil), field("size", "10", true, "text", nil))
	snap := snapshotOf(t, mod, raw)
	keys, err := snapshotFieldKeys(snap)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(keys, ",") != "color,size" {
		t.Fatalf("display order %v", keys)
	}
	var rev struct {
		Revision string `json:"schema_revision"`
	}
	if err := json.Unmarshal(snap, &rev); err != nil {
		t.Fatal(err)
	}
	sorted := revisionOf(t, mod, cacheInput(field("size", "10", true, "text", nil), field("color", "20", false, "text", nil)))
	if rev.Revision != sorted {
		t.Fatalf("display snapshot revision %s sorted %s", rev.Revision, sorted)
	}
}

func TestTypeOptionConstraintChangeRevision(t *testing.T) {
	mod := openEmbedded(t)
	base := cacheInput(field("color", "20", false, "single_select", []string{"1", "2"}))
	baseRev := revisionOf(t, mod, base)
	cases := []struct {
		name string
		raw  []byte
	}{
		{"type", cacheInput(field("color", "20", false, "integer", []string{"1", "2"}))},
		{"option", cacheInput(field("color", "20", false, "single_select", []string{"1", "3"}))},
		{"constraint", cacheInput(constrained("color", "20", false, "text", 2))},
	}
	for _, cse := range cases {
		got := revisionOf(t, mod, cse.raw)
		if got == baseRev {
			t.Fatalf("%s did not change the revision %s", cse.name, got)
		}
	}
}

func TestLegacyRevisionMatchesUnsortedWasm(t *testing.T) {
	mod := openEmbedded(t)
	raw := cacheInput(field("color", "20", false, "text", nil), field("size", "10", true, "text", nil))
	legacy, err := mod.LegacyRevision(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	unsorted, err := mod.snapshotWasm(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	want, ok := schemaRevisionOf(unsorted)
	if !ok || legacy != want {
		t.Fatalf("legacy %s wasm %s", legacy, want)
	}
	current := revisionOf(t, mod, raw)
	if legacy == current {
		t.Fatal("this fixture is already in attribute-id order, so the two hashes match; swap the fixture")
	}
}

func TestRustParityRealFieldChangeAgreesExceptOrder(t *testing.T) {
	mod := openEmbedded(t)
	base := cacheInput(
		field("color", "20", false, "single_select", []string{"1", "2"}),
		field("size", "10", true, "text", nil),
	)
	reordered := cacheInput(
		field("size", "10", true, "text", nil),
		field("color", "20", false, "single_select", []string{"1", "2"}),
	)
	added := cacheInput(
		field("color", "20", false, "single_select", []string{"1", "2"}),
		field("size", "10", true, "text", nil),
		field("brand", "31", true, "text", nil),
	)
	typed := cacheInput(
		field("color", "20", false, "integer", []string{"1", "2"}),
		field("size", "10", true, "text", nil),
	)
	option := cacheInput(
		field("color", "20", false, "single_select", []string{"9"}),
		field("size", "10", true, "text", nil),
	)
	// rustMoves is the legacy hash (field order hashed); goMoves sorts before the same wasm.
	// Order is the approved divergence. Semantic edits must move both hashes.
	rows := []struct {
		name      string
		raw       []byte
		rustMoves bool
		goMoves   bool
	}{
		{"order", reordered, true, false},
		{"new required", added, true, true},
		{"type", typed, true, true},
		{"option", option, true, true},
	}
	baseGo := revisionOf(t, mod, base)
	baseRust, err := mod.LegacyRevision(context.Background(), base)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		goRev := revisionOf(t, mod, row.raw)
		rustRev, err := mod.LegacyRevision(context.Background(), row.raw)
		if err != nil {
			t.Fatal(err)
		}
		if (goRev != baseGo) != row.goMoves {
			t.Fatalf("%s go move=%v\n base %s\n got %s", row.name, goRev != baseGo, baseGo, goRev)
		}
		if (rustRev != baseRust) != row.rustMoves {
			t.Fatalf("%s rust move=%v\n base %s\n got %s", row.name, rustRev != baseRust, baseRust, rustRev)
		}
		t.Logf("%s rust_moved=%v go_moved=%v rust=%s go=%s", row.name, rustRev != baseRust, goRev != baseGo, rustRev, goRev)
	}
}

func TestRebindStopsWasmSchemaStale(t *testing.T) {
	mod := openEmbedded(t)
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
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	var cse struct {
		Op     uint32
		Schema string
		Body   string
	}
	for _, item := range file.Cases {
		if item.Name == "golden-freeze" {
			cse.Op = item.Op
			cse.Schema = item.Schema
			cse.Body = item.Body
		}
	}
	stale := strings.Replace(cse.Body, `"schemaRevision":"local-v1"`, `"schemaRevision":"workflow:sha256:old-order"`, 1)
	out, err := mod.Call(context.Background(), cse.Op, []byte(cse.Schema), []byte(stale))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"reason":"schema_stale"`) {
		t.Fatalf("wasm still refuses a mismatched revision, got %s", out)
	}
	rebound := strings.Replace(stale, `"schemaRevision":"workflow:sha256:old-order"`, `"schemaRevision":"local-v1"`, 1)
	out, err = mod.Call(context.Background(), cse.Op, []byte(cse.Schema), []byte(rebound))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), `"reason":"schema_stale"`) {
		t.Fatalf("rebind still schema_stale: %s", out)
	}
	if !strings.Contains(string(out), `"status":"frozen"`) {
		t.Fatalf("rebind did not freeze: %s", out)
	}
}

func TestSpliceKeepsRevisionBytes(t *testing.T) {
	doc := []byte(`{"schema_revision":"workflow:sha256:abc","fields":[{"key":"b"},{"key":"a"}]}`)
	out, ok := spliceJSONArray(doc, "fields", []byte(`[{"key":"a"},{"key":"b"}]`))
	if !ok {
		t.Fatal("splice")
	}
	if !strings.Contains(string(out), `"schema_revision":"workflow:sha256:abc"`) {
		t.Fatalf("%s", out)
	}
	if !strings.HasSuffix(string(out), `[{"key":"a"},{"key":"b"}]}`) && !strings.Contains(string(out), `"fields":[{"key":"a"},{"key":"b"}]`) {
		t.Fatalf("%s", out)
	}
}

func openEmbedded(t *testing.T) *Module {
	t.Helper()
	mod, err := OpenEmbedded(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = mod.Close(context.Background()) })
	return mod
}

func revisionOf(t *testing.T, mod *Module, raw []byte) string {
	t.Helper()
	snap := snapshotOf(t, mod, raw)
	rev, ok := schemaRevisionOf(snap)
	if !ok {
		t.Fatalf("no revision in %s", snap)
	}
	return rev
}

func snapshotOf(t *testing.T, mod *Module, raw []byte) []byte {
	t.Helper()
	snap, err := mod.Snapshot(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	return snap
}

func cacheInput(fields ...json.RawMessage) []byte {
	body, err := json.Marshal(struct {
		Category int64             `json:"description_category_id"`
		TypeID   int64             `json:"type_id"`
		Fields   []json.RawMessage `json:"fields"`
	}{Category: 7, TypeID: 8, Fields: fields})
	if err != nil {
		panic(err)
	}
	return body
}

func field(key, attributeID string, required bool, editor string, optionIDs []string) json.RawMessage {
	options := make([]map[string]string, 0, len(optionIDs))
	for _, id := range optionIDs {
		options = append(options, map[string]string{"id": id, "value": id})
	}
	body, err := json.Marshal(map[string]any{
		"key": key, "label": key, "group": "Attrs", "editor": editor,
		"required": required, "collection": false, "attribute_id": attributeID,
		"options": options,
	})
	if err != nil {
		panic(err)
	}
	return body
}

func constrained(key, attributeID string, required bool, editor string, max uint32) json.RawMessage {
	body, err := json.Marshal(map[string]any{
		"key": key, "label": key, "group": "Attrs", "editor": editor,
		"required": required, "collection": true, "attribute_id": attributeID,
		"max_value_count": max,
	})
	if err != nil {
		panic(err)
	}
	return body
}
