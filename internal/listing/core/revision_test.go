package core

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	catalogcontract "github.com/xxww0098/podhub-go/internal/catalog/contract"
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

func TestRegistrySnapshotEquivalenceMatchesWasm(t *testing.T) {
	mod := openEmbedded(t)
	color := snapshotTestObject(t, field("color", "20", false, "single_select", []string{"1", "2"}))
	color["collection"] = true
	color["max_value_count"] = 2
	color["dictionary_id"] = "33"
	color["complex_id"] = "44"
	color["complex_group_collection"] = true
	color["aspect"] = true
	color["description"] = "Color description"
	color["raw_type"] = "String"
	baseColor := snapshotTestJSON(t, color)
	size := field("size", "10", true, "text", nil)
	baseInput := cacheInput(baseColor, size)
	base := snapshotOf(t, mod, baseInput)
	baseRevision, ok := schemaRevisionOf(base)
	if !ok || !catalogcontract.SameSnapshot(base, base) {
		t.Fatal("valid WASM snapshot must equal itself")
	}
	check := func(t *testing.T, input []byte, same bool) {
		t.Helper()
		other := snapshotOf(t, mod, input)
		revision, ok := schemaRevisionOf(other)
		if !ok || (revision == baseRevision) != same {
			t.Fatalf("WASM revision equivalence=%v, want %v", revision == baseRevision, same)
		}
		// Equality must inspect material even when a conflicting writer claims
		// the registered revision. Comparing revision strings alone is unsafe.
		claimed := snapshotTestObject(t, other)
		claimed["schema_revision"] = baseRevision
		other = snapshotTestJSON(t, claimed)
		if catalogcontract.SameSnapshot(base, other) != same || catalogcontract.SameSnapshot(other, base) != same {
			t.Fatalf("registry material equivalence must be %v", same)
		}
	}
	for _, test := range []struct {
		name, key string
		value     any
	}{
		{"label", "label", "New label"},
		{"group", "group", "New group"},
		{"description", "description", "New description"},
		{"raw type", "raw_type", "new display type"},
	} {
		t.Run("presentation/"+test.name, func(t *testing.T) {
			changed := snapshotTestObject(t, baseColor)
			changed[test.key] = test.value
			check(t, cacheInput(snapshotTestJSON(t, changed), size), true)
		})
	}
	t.Run("semantic/aspect unknown differs from false", func(t *testing.T) {
		known, unknown := snapshotTestObject(t, baseColor), snapshotTestObject(t, baseColor)
		known["aspect"], unknown["aspect"] = false, nil
		a := snapshotOf(t, mod, cacheInput(snapshotTestJSON(t, known), size))
		b := snapshotOf(t, mod, cacheInput(snapshotTestJSON(t, unknown), size))
		aRevision, _ := schemaRevisionOf(a)
		bRevision, _ := schemaRevisionOf(b)
		if aRevision == bRevision {
			t.Fatal("WASM collapsed unknown aspect into false")
		}
		claimed := snapshotTestObject(t, b)
		claimed["schema_revision"] = aRevision
		if catalogcontract.SameSnapshot(a, snapshotTestJSON(t, claimed)) {
			t.Fatal("registry comparison collapsed unknown aspect into false")
		}
	})
	t.Run("presentation/field order", func(t *testing.T) {
		check(t, cacheInput(size, baseColor), true)
	})
	for _, key := range []string{"value", "info", "picture"} {
		t.Run("presentation/option "+key, func(t *testing.T) {
			changed := snapshotTestObject(t, baseColor)
			changed["options"].([]any)[0].(map[string]any)[key] = "new display value"
			check(t, cacheInput(snapshotTestJSON(t, changed), size), true)
		})
	}
	t.Run("presentation/option order", func(t *testing.T) {
		changed := snapshotTestObject(t, baseColor)
		options := changed["options"].([]any)
		options[0], options[1] = options[1], options[0]
		check(t, cacheInput(snapshotTestJSON(t, changed), size), true)
	})
	for _, test := range []struct {
		name, key string
		value     any
	}{
		{"key", "key", "other_color"},
		{"required", "required", true},
		{"editor", "editor", "multi_select"},
		{"collection", "collection", false},
		{"max value count", "max_value_count", 3},
		{"dictionary ID", "dictionary_id", "34"},
		{"attribute ID", "attribute_id", "21"},
		{"complex ID", "complex_id", "45"},
		{"complex collection", "complex_group_collection", false},
		{"read only", "read_only", true},
		{"truncated options", "options_truncated", true},
		{"aspect false", "aspect", false},
		{"aspect unknown", "aspect", nil},
	} {
		t.Run("semantic/"+test.name, func(t *testing.T) {
			changed := snapshotTestObject(t, baseColor)
			changed[test.key] = test.value
			check(t, cacheInput(snapshotTestJSON(t, changed), size), false)
		})
	}
	t.Run("semantic/option ID", func(t *testing.T) {
		changed := snapshotTestObject(t, baseColor)
		changed["options"].([]any)[0].(map[string]any)["id"] = "3"
		check(t, cacheInput(snapshotTestJSON(t, changed), size), false)
	})
	t.Run("semantic/duplicate option ID", func(t *testing.T) {
		changed := snapshotTestObject(t, baseColor)
		options := changed["options"].([]any)
		changed["options"] = append(options, options[0])
		check(t, cacheInput(snapshotTestJSON(t, changed), size), false)
	})
	t.Run("semantic/duplicate field", func(t *testing.T) {
		check(t, cacheInput(baseColor, size, baseColor), false)
	})
	for _, key := range []string{"description_category_id", "type_id"} {
		t.Run("semantic/"+key, func(t *testing.T) {
			input := snapshotTestObject(t, baseInput)
			input[key] = 99
			check(t, snapshotTestJSON(t, input), false)
		})
	}
	// The live-fields WASM helper fixes recipe and catalog versions at zero.
	// Registry comparison must still retain them and unknown future material.
	for _, test := range []struct {
		key   string
		value any
		same  bool
	}{
		{"label", "New category label", true},
		{"category_key", "workflow:other", false},
		{"recipe_id", 1, false},
		{"recipe_revision", 1, false},
		{"catalog_schema_version", 1, false},
		{"future_semantic", map[string]any{"label": "must remain significant"}, false},
	} {
		t.Run("snapshot envelope/"+test.key, func(t *testing.T) {
			changed := snapshotTestObject(t, base)
			changed[test.key] = test.value
			if catalogcontract.SameSnapshot(base, snapshotTestJSON(t, changed)) != test.same {
				t.Fatalf("snapshot envelope %s equivalence must be %v", test.key, test.same)
			}
		})
	}
	for _, option := range []bool{false, true} {
		name := "field"
		if option {
			name = "option"
		}
		t.Run("unknown material/"+name, func(t *testing.T) {
			changed := snapshotTestObject(t, base)
			object := changed["fields"].([]any)[0].(map[string]any)
			if option {
				object = object["options"].([]any)[0].(map[string]any)
			}
			object["future_semantic"] = map[string]any{"label": "must remain significant"}
			if catalogcontract.SameSnapshot(base, snapshotTestJSON(t, changed)) {
				t.Fatalf("unknown %s material was discarded", name)
			}
		})
	}
	t.Run("large integer identity", func(t *testing.T) {
		a, b := snapshotTestObject(t, base), snapshotTestObject(t, base)
		a["recipe_id"], b["recipe_id"] = int64(9007199254740992), int64(9007199254740993)
		if catalogcontract.SameSnapshot(snapshotTestJSON(t, a), snapshotTestJSON(t, b)) {
			t.Fatal("distinct integer identities collapsed through float64")
		}
	})
}

func snapshotTestObject(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		t.Fatal(err)
	}
	return object
}

func snapshotTestJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
