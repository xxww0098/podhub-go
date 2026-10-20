package domain

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/xxww0098/podhub-go/internal/listing/core/contract"
)

// SearchTagsAttributeID is listing_core::SEARCH_TAGS_ATTRIBUTE_ID (23171).
const SearchTagsAttributeID = contract.SearchTagsAttributeID

func init() {
	contract.SearchTagTokens = SearchTagTokens
}

// SearchTagTokens is reject_banned_search_tags without the database.
// schemaFields is the category field array. draft is a WorkflowCategoryDraft.
// An empty key list allows the draft. A schema that is not an array is an error
// so the caller can fail the save closed.
func SearchTagTokens(schemaFields, draft []byte) ([]string, error) {
	keys, err := searchTagKeys(schemaFields)
	if err != nil || len(keys) == 0 {
		return nil, err
	}
	var body struct {
		Values        map[string]json.RawMessage `json:"values"`
		ComplexValues []struct {
			Items []struct {
				Values map[string]json.RawMessage `json:"values"`
			} `json:"items"`
		} `json:"complex_values"`
	}
	if len(bytes.TrimSpace(draft)) == 0 {
		return nil, nil
	}
	if err := json.Unmarshal(draft, &body); err != nil {
		return nil, err
	}
	var tokens []string
	take := func(values map[string]json.RawMessage) {
		for _, key := range keys {
			raw, ok := values[key]
			if !ok {
				continue
			}
			tokens = append(tokens, valueTokens(raw)...)
		}
	}
	take(body.Values)
	for _, group := range body.ComplexValues {
		for _, item := range group.Items {
			take(item.Values)
		}
	}
	return tokens, nil
}

func searchTagKeys(schemaFields []byte) ([]string, error) {
	if len(bytes.TrimSpace(schemaFields)) == 0 {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(schemaFields))
	dec.UseNumber()
	var fields []map[string]any
	if err := dec.Decode(&fields); err != nil {
		return nil, err
	}
	var keys []string
	for _, field := range fields {
		key, _ := field["key"].(string)
		if key == "" {
			continue
		}
		if attributeID(field) == SearchTagsAttributeID {
			keys = append(keys, key)
		}
	}
	return keys, nil
}

func attributeID(field map[string]any) int64 {
	for _, name := range []string{"attribute_id", "attributeId"} {
		switch n := field[name].(type) {
		case json.Number:
			v, err := n.Int64()
			if err == nil {
				return v
			}
		case float64:
			return int64(n)
		}
	}
	return 0
}

func valueTokens(raw json.RawMessage) []string {
	var tagged struct {
		Kind  string          `json:"kind"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(raw, &tagged); err != nil {
		return nil
	}
	switch tagged.Kind {
	case "text", "url":
		var text string
		if err := json.Unmarshal(tagged.Value, &text); err != nil {
			return nil
		}
		return strings.Fields(text)
	case "text_list", "url_list":
		var texts []string
		if err := json.Unmarshal(tagged.Value, &texts); err != nil {
			return nil
		}
		var out []string
		for _, text := range texts {
			out = append(out, strings.Fields(text)...)
		}
		return out
	default:
		return nil
	}
}
