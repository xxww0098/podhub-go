package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
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
// A valid schema without search-tag fields allows the draft. Invalid schemas
// return an error so the caller can fail the save closed.
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
	// Catalog fields use string IDs; numeric IDs are also part of the schema
	// contract. json.Number preserves both without float conversion and rejects
	// non-numeric strings. Unmarshal rejects trailing JSON as well.
	var fields []struct {
		Key              string      `json:"key"`
		AttributeID      json.Number `json:"attribute_id"`
		AttributeIDCamel json.Number `json:"attributeId"`
	}
	if err := json.Unmarshal(schemaFields, &fields); err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, fmt.Errorf("category fields must be an array")
	}
	var keys []string
	for i, field := range fields {
		if strings.TrimSpace(field.Key) == "" {
			return nil, fmt.Errorf("category field %d has no key", i)
		}
		id, err := attributeID(field.AttributeID, field.AttributeIDCamel)
		if err != nil {
			return nil, fmt.Errorf("category field %d: %w", i, err)
		}
		if id == SearchTagsAttributeID {
			keys = append(keys, field.Key)
		}
	}
	return keys, nil
}

func attributeID(snake, camel json.Number) (int64, error) {
	var id int64
	for _, n := range []json.Number{snake, camel} {
		if n == "" {
			// Base fields have no attribute ID (omitted or null).
			continue
		}
		v, err := n.Int64()
		if err != nil || v <= 0 {
			return 0, fmt.Errorf("attribute ID must be a positive int64")
		}
		if id != 0 && id != v {
			return 0, fmt.Errorf("conflicting attribute_id and attributeId")
		}
		id = v
	}
	return id, nil
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
