package domain

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

func TestSearchTagTokensCatalogFieldEncoding(t *testing.T) {
	// marshalCatalogFields in internal/catalog/http/live.go writes the optional
	// attribute_id as *string, not as a JSON number. Non-attribute fields omit it.
	schema := []byte(`[
		{"key":"name","label":"Name","group":"base","editor":"text","required":true,"collection":false},
		{"key":"attr:23171","label":"Tags","group":"attributes","editor":"text_list","required":false,"collection":true,"attribute_id":"23171"}
	]`)
	draft := []byte(`{"values":{"name":{"kind":"text","value":"ignored"},"attr:23171":{"kind":"text","value":"one two"}},"complex_values":[{"items":[{"values":{"attr:23171":{"kind":"text_list","value":["three four","five"]}}}]}]}`)
	got, err := SearchTagTokens(schema, draft)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"one", "two", "three", "four", "five"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("catalog string ID lost tokens: got %q, want %q", got, want)
	}
}

func TestSearchTagTokensAttributeEncodings(t *testing.T) {
	draft := []byte(`{"values":{"tags":{"kind":"text","value":"one two"}}}`)
	for _, fields := range []string{
		`[{"key":"tags","attribute_id":"23171"}]`,
		`[{"key":"tags","attribute_id":23171}]`,
		`[{"key":"tags","attributeId":"23171"}]`,
		`[{"key":"tags","attributeId":23171}]`,
		`[{"key":"tags","attribute_id":"23171","attributeId":23171}]`,
	} {
		t.Run(fields, func(t *testing.T) {
			got, err := SearchTagTokens([]byte(fields), draft)
			if err != nil || !reflect.DeepEqual(got, []string{"one", "two"}) {
				t.Fatalf("got %q, %v", got, err)
			}
		})
	}
}

func TestSearchTagTokensInvalidSchemaFailsClosed(t *testing.T) {
	draft := []byte(`{"values":{"tags":{"kind":"text","value":"must be checked"}}}`)
	for _, schema := range []string{
		``, ` `, `null`, `{}`, `[`, `[null]`, `[1]`,
		`[] {}`, `[] garbage`,
		`[{"attribute_id":"23171"}]`,
		`[{"key":"","attribute_id":"23171"}]`,
		`[{"key":" ","attribute_id":"23171"}]`,
		`[{"key":1,"attribute_id":"23171"}]`,
		`[{"key":"tags","attribute_id":""}]`,
		`[{"key":"tags","attribute_id":"not-an-id"}]`,
		`[{"key":"tags","attribute_id":true}]`,
		`[{"key":"tags","attribute_id":{}}]`,
		`[{"key":"tags","attribute_id":[]}]`,
		`[{"key":"tags","attribute_id":0}]`,
		`[{"key":"tags","attribute_id":-1}]`,
		`[{"key":"tags","attribute_id":23171.5}]`,
		`[{"key":"tags","attribute_id":"23171.5"}]`,
		`[{"key":"tags","attribute_id":9223372036854775808}]`,
		`[{"key":"tags","attribute_id":"9223372036854775808"}]`,
		`[{"key":"tags","attribute_id":1,"attributeId":23171}]`,
		`[{"key":"tags","attribute_id":"bad","attributeId":23171}]`,
		`[{"key":"tags","attribute_id":23171,"attributeId":"bad"}]`,
	} {
		t.Run(schema, func(t *testing.T) {
			got, err := SearchTagTokens([]byte(schema), draft)
			if err == nil || got != nil {
				t.Fatalf("invalid schema must return an error and no tokens: got %q, %v", got, err)
			}
		})
	}
}

func TestSearchTagTokensOptionalAttributeAndNoTagField(t *testing.T) {
	for _, schema := range []string{
		`[]`,
		`[{"key":"name"}]`,
		`[{"key":"name","attribute_id":null}]`,
		`[{"key":"name","attributeId":null}]`,
		`[{"key":"name","attribute_id":"1"}]`,
		`[{"key":"name","attribute_id":1}]`,
	} {
		t.Run(schema, func(t *testing.T) {
			got, err := SearchTagTokens([]byte(schema), []byte(`{}`))
			if err != nil || got != nil {
				t.Fatalf("valid schema without search tags: got %q, %v", got, err)
			}
		})
	}
}

func FuzzSearchTagTokensAttributeEncoding(f *testing.F) {
	for _, id := range []int64{1, SearchTagsAttributeID, 9223372036854775807} {
		f.Add(id)
	}
	f.Fuzz(func(t *testing.T, id int64) {
		if id <= 0 {
			return
		}
		draft := []byte(`{"values":{"tags":{"kind":"text","value":"one two"}}}`)
		var want []string
		if id == SearchTagsAttributeID {
			want = []string{"one", "two"}
		}
		for _, schema := range []string{
			fmt.Sprintf(`[{"key":"tags","attribute_id":%d}]`, id),
			fmt.Sprintf(`[{"key":"tags","attribute_id":"%d"}]`, id),
			fmt.Sprintf(`[{"key":"tags","attributeId":%d}]`, id),
			fmt.Sprintf(`[{"key":"tags","attributeId":"%d"}]`, id),
		} {
			got, err := SearchTagTokens([]byte(schema), draft)
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("schema %s: got %q, %v; want %q", schema, got, err, want)
			}
		}
	})
}

func FuzzSearchTagTokensSchema(f *testing.F) {
	for _, schema := range []string{`[]`, `null`, `[{"key":"tags","attribute_id":"23171"}]`, `[] {}`} {
		f.Add(schema)
	}
	f.Fuzz(func(t *testing.T, schema string) {
		got, err := SearchTagTokens([]byte(schema), []byte(`{"values":{"tags":{"kind":"text","value":"one two"}}}`))
		if err != nil && got != nil {
			t.Fatalf("error returned partial tokens: %q, %v", got, err)
		}
		if !json.Valid([]byte(schema)) && err == nil {
			t.Fatalf("invalid JSON allowed: %q", schema)
		}
	})
}
