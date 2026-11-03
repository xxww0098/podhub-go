package app

import (
	"context"
	"encoding/json"
	"testing"
)

func TestSupplierConfigUsesCommittedWasmRequiredDictionaryAndItemRules(t *testing.T) {
	material := []byte(`{"description_category_id":1,"type_id":2,"fields":[{"key":"name","label":"Name","group":"Fixed","editor":"text","collection":false,"required":true,"options":[]},{"key":"width","label":"Width","group":"Fixed","editor":"integer","collection":false,"required":true,"options":[]},{"key":"currency_code","label":"Currency","group":"Fixed","editor":"text","required":false,"collection":false,"options":[]},{"key":"attribute_85","label":"Brand","group":"Attributes","editor":"dictionary_search","collection":false,"required":true,"attribute_id":"85","dictionary_id":"5","options":[],"options_truncated":true},{"key":"attribute_8790","label":"PDF URL","group":"PDF","editor":"url","required":false,"collection":false,"attribute_id":"8790","complex_id":"8788","complex_group_collection":true,"options":[]}],"searchMaterials":[{"descriptionCategoryId":1,"attributeId":85,"dictionaryId":5,"valueId":7,"label":"Confirmed"}]}`)
	valid := `{"values":{"fixed:width":[{"kind":"integer","value":10}],"fixed:currency_code":[{"kind":"text","value":"RUB"}],"attribute:85:0":[{"kind":"options","options":[{"option_id":7,"value":"Confirmed"}]}]},"complex_values":[{"complex_id":8788,"items":[{"item_id":"00000000-0000-4000-8000-000000000001","values":{"attribute:8790:8788":[{"kind":"text","value":"https://example.com/1.pdf"}]}},{"item_id":"ci_233dcabfbac64c558e36b13b7d872aae","values":{"attribute:8790:8788":[{"kind":"text","value":"https://example.com/2.pdf"}]}}]}]}`
	check := func(input []byte) []map[string]any {
		t.Helper()
		raw, err := validateSupplierConfig(context.Background(), material, input)
		if err != nil {
			t.Fatal(err)
		}
		var issues []map[string]any
		if err = json.Unmarshal(raw, &issues); err != nil {
			t.Fatal(err)
		}
		return issues
	}
	if issues := check([]byte(valid)); len(issues) != 0 {
		t.Fatalf("valid defaults failed: %+v", issues)
	}
	var bad map[string]any
	_ = json.Unmarshal([]byte(valid), &bad)
	values := bad["values"].(map[string]any)
	delete(values, "fixed:width")
	delete(values, "fixed:currency_code")
	values["attribute:85:0"].([]any)[0].(map[string]any)["options"].([]any)[0].(map[string]any)["option_id"] = 99999
	bad["complex_values"].([]any)[0].(map[string]any)["items"].([]any)[1].(map[string]any)["values"].(map[string]any)["attribute:8790:8788"].([]any)[0].(map[string]any)["value"] = "invalid-url"
	raw, _ := json.Marshal(bad)
	issues := check(raw)
	found := map[string]bool{}
	for _, issue := range issues {
		key := issue["field_key"].(string)
		found[key] = true
		if key == "width" && issue["code"] != "required" {
			t.Fatalf("required rule lost: %+v", issue)
		}
		if key == "attribute_8790" && (issue["complex_id"] != float64(8788) || issue["item_index"] != float64(1)) {
			t.Fatalf("wrong item address: %+v", issue)
		}
	}
	// Currency is owned by the destination store contract, not a supplier
	// default, so removing it must not produce a field issue here.
	if len(issues) != 3 || found["currency_code"] || !found["width"] || !found["attribute_85"] || !found["attribute_8790"] {
		t.Fatalf("shared WASM rules lost: %+v", issues)
	}
}
