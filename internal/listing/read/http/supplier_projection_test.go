package readhttp

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestSupplierConfigAlwaysAllowsAllRecognitionOutputsWithoutCopyingOverrides(t *testing.T) {
	config := []byte(`{"fixed:width":[{"kind":"integer","value":450}],"fixed:vat":[{"kind":"decimal","value":"0"}],"attribute:85:0":[{"kind":"options","options":[{"option_id":7,"value":"Нет бренда"}]}],"fixed:name":[{"kind":"text","value":"do not seed"}]}`)
	fields := []byte(`[{"key":"width","editor":"integer"},{"key":"vat","editor":"decimal"},{"key":"attribute_85","editor":"dictionary_search"},{"key":"name","editor":"text"},{"key":"attribute_4191","editor":"text"},{"key":"attribute_23171","editor":"text"}]`)
	draft, policy, err := supplierDraft(config, []byte(`[]`), fields, []byte(`{"values":{"price":{"kind":"text","value":"99"},"width":{"kind":"integer","value":999}}}`))
	if err != nil {
		t.Fatal(err)
	}
	values := draft["values"].(map[string]any)
	raw, _ := json.Marshal(values)
	if strings.Contains(string(raw), "999") || strings.Contains(string(raw), "do not seed") || !strings.Contains(string(raw), `"value":450`) || !strings.Contains(string(raw), `"value":0`) || !strings.Contains(string(raw), `"dictionary_value_id":7`) || !strings.Contains(string(raw), `"value":"99"`) {
		t.Fatalf("projection %s", raw)
	}
	for _, key := range []string{"name", "attribute_4191", "attribute_23171"} {
		if _, ok := values[key]; ok {
			t.Fatalf("recognition output %s must be blank until recognition", key)
		}
	}
	if !reflect.DeepEqual(policy["allowed_field_keys"], []string{"name", "attribute_4191", "attribute_23171"}) || !reflect.DeepEqual(policy["protected_field_keys"], []string{}) {
		t.Fatalf("recognition must fill title, description and tags: %#v", policy)
	}
}

func TestSupplierComplexProjectionPreservesEveryItemAndRejectsWrongPlacement(t *testing.T) {
	fields := []byte(`[{"key":"attribute_8790","editor":"url","complex_id":"8788"},{"key":"attribute_21841","editor":"url","complex_id":"100001"}]`)
	complex := []byte(`[{"complex_id":8788,"items":[{"item_id":"first","values":{"attribute:8790:8788":[{"kind":"text","value":"https://example.com/1.pdf"}]}},{"item_id":"second","values":{"attribute:8790:8788":[{"kind":"text","value":"https://example.com/2.pdf"}]}}]},{"complex_id":100001,"items":[{"item_id":"video","values":{"attribute:21841:100001":[{"kind":"text","value":"https://example.com/clip.mp4"}]}}]},{"complex_id":100002,"items":[{"item_id":"cover","values":{}}]}]`)
	draft, _, err := supplierDraft([]byte(`{}`), complex, fields, nil)
	if err != nil {
		t.Fatal(err)
	}
	groups := draft["complex_values"].([]any)
	items := groups[0].(map[string]any)["items"].([]any)
	if len(groups) != 1 || len(items) != 2 || items[0].(map[string]any)["item_id"] != "first" || items[1].(map[string]any)["item_id"] != "second" {
		t.Fatalf("lost items or order: %#v", groups)
	}
	second := items[1].(map[string]any)["values"].(map[string]any)["attribute_8790"].(map[string]any)
	if second["kind"] != "url" || second["value"] != "https://example.com/2.pdf" {
		t.Fatalf("lost complex values: %#v", groups)
	}
	for _, invalid := range []string{strings.Replace(string(complex), "attribute:8790:8788", "attribute:8790:999", 1), strings.Replace(string(complex), "attribute:8790:8788", "attribute:21841:8788", 1)} {
		if _, _, err = supplierDraft([]byte(`{}`), []byte(invalid), fields, nil); err == nil {
			t.Fatal("wrong complex placement accepted")
		}
	}
}
