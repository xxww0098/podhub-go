package domain

import "testing"

func TestSearchTagTokensMatchTheRustFilter(t *testing.T) {
	schema := []byte(`[{"key":"title","attribute_id":1},{"key":"tags","attributeId":23171}]`)
	draft := []byte(`{"values":{"tags":{"kind":"text","value":"one  two"},"title":{"kind":"text","value":"ignored"}},"complex_values":[{"items":[{"values":{"tags":{"kind":"text_list","value":["three four"]}}}]}]}`)
	got, err := SearchTagTokens(schema, draft)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 || got[0] != "one" || got[1] != "two" || got[2] != "three" || got[3] != "four" {
		t.Fatalf("%q", got)
	}
	none, err := SearchTagTokens([]byte(`[{"key":"title","attribute_id":1}]`), draft)
	if err != nil || none != nil {
		t.Fatalf("empty keys allow: %v %q", err, none)
	}
	if _, err := SearchTagTokens([]byte(`{"not":"array"}`), draft); err == nil {
		t.Fatal("a non-array schema must fail closed")
	}
}
