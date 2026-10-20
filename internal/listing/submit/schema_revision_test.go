package submit

import (
	"testing"
)

func TestCacheRefreshOrderChangeStillSendable(t *testing.T) {
	// The row was hashed on a previous field order. The cache has
	// since reordered the same fields, so neither the new hash nor the legacy
	// hash of the current order equals the stored revision. Nothing required
	// was added, so the row is rebound and sent, and no revision row is written.
	before := []schemaField{{Key: "size", AttributeID: "10", Required: true, Editor: "text"}, {Key: "color", AttributeID: "20", Editor: "text"}}
	after := []schemaField{{Key: "color", AttributeID: "20", Editor: "text"}, {Key: "size", AttributeID: "10", Required: true, Editor: "text"}}
	decision := decideSchema("workflow:sha256:old-order", "workflow:sha256:sorted", "workflow:sha256:current-order", before, after, map[string]bool{"size": true})
	if len(decision.Block) != 0 || decision.Record || decision.Rebind != "workflow:sha256:sorted" {
		t.Fatalf("%+v", decision)
	}
}

func TestHistoricalOrderWithoutSnapshotStillSendable(t *testing.T) {
	// listing_schema_revisions has no snapshot for the stored hash. The order
	// change must not be treated as a new required field and must not be recorded.
	decision := decideSchema("workflow:sha256:old-order", "workflow:sha256:sorted", "workflow:sha256:current-order", nil, []schemaField{{Key: "size", Required: true}}, map[string]bool{"size": true})
	if len(decision.Block) != 0 || decision.Record || decision.Rebind != "workflow:sha256:sorted" {
		t.Fatalf("%+v", decision)
	}
}

func TestLegacyHashIsUnchanged(t *testing.T) {
	decision := decideSchema("workflow:sha256:legacy", "workflow:sha256:sorted", "workflow:sha256:legacy", nil, nil, nil)
	if len(decision.Block) != 0 || decision.Record || decision.Rebind != "workflow:sha256:sorted" {
		t.Fatalf("%+v", decision)
	}
}

func TestCurrentHashIsUnchanged(t *testing.T) {
	decision := decideSchema("workflow:sha256:sorted", "workflow:sha256:sorted", "workflow:sha256:legacy", nil, nil, nil)
	if len(decision.Block) != 0 || decision.Record {
		t.Fatalf("%+v", decision)
	}
}

func TestOrderOnlyDoesNotWriteSchemaRevision(t *testing.T) {
	size := schemaField{Key: "size", AttributeID: "10", Editor: "text", Required: true}
	color := schemaField{Key: "color", AttributeID: "20", Editor: "single_select", OptionIDs: []string{"1", "2"}}
	first := decideSchema("workflow:sha256:old", "workflow:sha256:sorted", "workflow:sha256:order-a", []schemaField{size, color}, []schemaField{color, size}, map[string]bool{"size": true})
	second := decideSchema("workflow:sha256:sorted", "workflow:sha256:sorted", "workflow:sha256:order-b", []schemaField{color, size}, []schemaField{size, color}, map[string]bool{"size": true})
	if first.Record || second.Record {
		t.Fatalf("order-only recorded %+v %+v", first, second)
	}
	if len(first.Block) != 0 || len(second.Block) != 0 {
		t.Fatal("order-only blocked")
	}
}

func TestNewRequiredFieldBlocksAndNamesField(t *testing.T) {
	before := []schemaField{{Key: "size", AttributeID: "10", Editor: "text", Required: true}}
	after := []schemaField{
		{Key: "size", AttributeID: "10", Editor: "text", Required: true},
		{Key: "brand", AttributeID: "31", Editor: "text", Required: true},
	}
	decision := decideSchema("workflow:sha256:old", "workflow:sha256:new", "workflow:sha256:legacy", before, after, map[string]bool{"size": true})
	if len(decision.Block) != 1 || decision.Block[0] != "brand" {
		t.Fatalf("%+v", decision)
	}
	if !decision.Record {
		t.Fatal("a real schema change should be recordable")
	}
}

func TestNewRequiredFieldSatisfiedContinues(t *testing.T) {
	before := []schemaField{{Key: "size", AttributeID: "10", Editor: "text", Required: true}}
	after := []schemaField{
		{Key: "size", AttributeID: "10", Editor: "text", Required: true},
		{Key: "brand", AttributeID: "31", Editor: "text", Required: true},
	}
	decision := decideSchema("workflow:sha256:old", "workflow:sha256:new", "workflow:sha256:legacy", before, after, map[string]bool{"size": true, "brand": true})
	if len(decision.Block) != 0 || decision.Rebind != "workflow:sha256:new" || !decision.Record {
		t.Fatalf("%+v", decision)
	}
}

func TestTypeOptionConstraintStillChangeTheRevisionDecision(t *testing.T) {
	base := schemaField{Key: "color", AttributeID: "20", Editor: "single_select", OptionIDs: []string{"1", "2"}}
	cases := []schemaField{
		{Key: "color", AttributeID: "20", Editor: "integer", OptionIDs: []string{"1", "2"}},
		{Key: "color", AttributeID: "20", Editor: "single_select", OptionIDs: []string{"1", "3"}},
		{Key: "color", AttributeID: "20", Editor: "text", Collection: true, Max: ptrUint(2), OptionIDs: []string{"1", "2"}},
	}
	for i, after := range cases {
		if semanticEqual([]schemaField{base}, []schemaField{after}) {
			t.Fatalf("case %d compared equal", i)
		}
		decision := decideSchema("old", "new", "legacy", []schemaField{base}, []schemaField{after}, map[string]bool{"color": true})
		if len(decision.Block) != 0 || !decision.Record || decision.Rebind != "new" {
			t.Fatalf("case %d %+v", i, decision)
		}
	}
}

func TestFilledFalseAndZeroCount(t *testing.T) {
	raw := []byte(`{"draft":{"values":{"flag":{"kind":"boolean","value":false},"qty":{"kind":"integer","value":0},"name":{"kind":"text","value":"  "},"empty":{"kind":"text_list","value":[]}},"cleared":["qty"]}}`)
	got := filledFieldKeys(raw)
	if !got["flag"] || got["qty"] || got["name"] || got["empty"] {
		t.Fatalf("%v", got)
	}
}

func TestBindSchemaRevisionRewritesOnlyThePin(t *testing.T) {
	raw := []byte(`{"rowId":"11111111-1111-4111-8111-111111111111","schemaRevision":"workflow:sha256:old","draft":{"values":{"size":{"kind":"text","value":"M"}}}}`)
	out, err := bindSchemaRevision(raw, "workflow:sha256:new")
	if err != nil {
		t.Fatal(err)
	}
	if draftRevision(out) != "workflow:sha256:new" {
		t.Fatalf("%s", out)
	}
	if draftRowID(out) != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("%s", out)
	}
	if !filledFieldKeys(out)["size"] {
		t.Fatalf("%s", out)
	}
}

func ptrUint(n uint32) *uint32 { return &n }
