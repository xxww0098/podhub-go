package contract

import (
	"slices"
	"testing"
)

func TestComplexEnvelopeCannotStoreAnUnreadableDraftWithoutCatalog(t *testing.T) {
	for _, raw := range []string{`null`, `{}`, `[null]`, `[{"complex_id":9,"items":null}]`, `[{"complex_id":9,"items":[{"values":{}}]}]`, `[{"complex_id":9,"items":[{"item_id":"a","values":null}]}]`, `[{"complex_id":9,"items":[],"extra":true}]`} {
		if _, err := decodeComplexValues([]byte(raw)); err == nil {
			t.Errorf("unreadable envelope accepted: %s", raw)
		}
	}
	for _, raw := range []string{`[]`, `[{"complex_id":9,"items":[{"item_id":"a","values":{}}]}]`} {
		if _, err := decodeComplexValues([]byte(raw)); err != nil {
			t.Errorf("readable draft rejected: %s: %v", raw, err)
		}
	}
}

func TestOzonConfigAllowsMissingTagsInDraftOnly(t *testing.T) {
	const prefix = `{"description_category_id":1,"type_id":2,"language":"ru","values":{},"complex_values":[],"prompt_text":"","ai_output":{"title":true,"description":true,"tags":true},"expected_revision":0,"fixed_tags":`
	draft, err := DecodeOzon([]byte(prefix + `[]}`))
	if err != nil {
		t.Fatal("incomplete draft rejected", err)
	}
	var row RowData
	row.FillReadiness(RowFacts{FixedTags: draft.Tags})
	if !slices.Contains(MissingKeys(row.Readiness), "fixedTags") {
		t.Fatal("missing tags must still block publication")
	}
	if _, err := DecodeOzon([]byte(prefix + `["invalid"]}`)); err == nil {
		t.Fatal("malformed tags accepted")
	}
	if _, err := DecodeOzon([]byte(prefix + `["#\u0442\u0435\u0441\u0442"]}`)); err != nil {
		t.Fatal("valid fixed tags rejected", err)
	}
}
