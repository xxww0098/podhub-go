// Package fieldpack is the per-user ozon_field_packs store.
// Packs are not org rows and are not under RLS. Another user's id is absent,
// not forbidden.
package fieldpack

import (
	"bytes"
	"encoding/json"
	"errors"
	"sort"

	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

// EncodeBody rewrites a FieldLibraryBody into serde field order.
// decimal kinds are refused: f64 bytes are not proven against serde_json.
func EncodeBody(raw []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var body struct {
		Values        map[string]json.RawMessage `json:"values"`
		ComplexValues []struct {
			ComplexID int64 `json:"complex_id"`
			Items     []struct {
				Values map[string]json.RawMessage `json:"values"`
			} `json:"items"`
		} `json:"complex_values"`
		Cleared []string `json:"cleared"`
	}
	if err := dec.Decode(&body); err != nil {
		return nil, err
	}
	values, err := encodeMap(body.Values)
	if err != nil {
		return nil, err
	}
	groups := make([]encodedGroup, 0, len(body.ComplexValues))
	for _, group := range body.ComplexValues {
		items := make([]encodedItem, 0, len(group.Items))
		for _, item := range group.Items {
			itemValues, err := encodeMap(item.Values)
			if err != nil {
				return nil, err
			}
			items = append(items, encodedItem{Values: itemValues})
		}
		groups = append(groups, encodedGroup{ComplexID: group.ComplexID, Items: items})
	}
	sort.Strings(body.Cleared)
	out := encodedBody{Values: values, ComplexValues: groups}
	if len(body.Cleared) > 0 {
		out.Cleared = body.Cleared
	}
	return jsonwire.Marshal(out)
}

type encodedBody struct {
	Values        map[string]encodedValue `json:"values"`
	ComplexValues []encodedGroup          `json:"complex_values"`
	Cleared       []string                `json:"cleared,omitempty"`
}

type encodedGroup struct {
	ComplexID int64         `json:"complex_id"`
	Items     []encodedItem `json:"items"`
}

type encodedItem struct {
	Values map[string]encodedValue `json:"values"`
}

type encodedValue struct {
	Kind  string `json:"kind"`
	Value any    `json:"value"`
}

func encodeMap(raw map[string]json.RawMessage) (map[string]encodedValue, error) {
	if raw == nil {
		raw = map[string]json.RawMessage{}
	}
	out := make(map[string]encodedValue, len(raw))
	for key, value := range raw {
		encoded, err := encodeValue(value)
		if err != nil {
			return nil, err
		}
		out[key] = encoded
	}
	return out, nil
}

func encodeValue(raw json.RawMessage) (encodedValue, error) {
	var tagged struct {
		Kind  string          `json:"kind"`
		Value json.RawMessage `json:"value"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&tagged); err != nil {
		return encodedValue{}, err
	}
	switch tagged.Kind {
	case "text", "url":
		var text string
		if err := json.Unmarshal(tagged.Value, &text); err != nil {
			return encodedValue{}, err
		}
		return encodedValue{Kind: tagged.Kind, Value: text}, nil
	case "text_list", "url_list":
		var texts []string
		if err := json.Unmarshal(tagged.Value, &texts); err != nil {
			return encodedValue{}, err
		}
		if texts == nil {
			texts = []string{}
		}
		return encodedValue{Kind: tagged.Kind, Value: texts}, nil
	case "integer":
		n, err := integerValue(tagged.Value)
		if err != nil {
			return encodedValue{}, err
		}
		return encodedValue{Kind: tagged.Kind, Value: n}, nil
	case "integer_list":
		var nums []json.RawMessage
		if err := json.Unmarshal(tagged.Value, &nums); err != nil {
			return encodedValue{}, err
		}
		out := make([]int64, 0, len(nums))
		for _, item := range nums {
			n, err := integerValue(item)
			if err != nil {
				return encodedValue{}, err
			}
			out = append(out, n)
		}
		return encodedValue{Kind: tagged.Kind, Value: out}, nil
	case "boolean":
		var v bool
		if err := json.Unmarshal(tagged.Value, &v); err != nil {
			return encodedValue{}, err
		}
		return encodedValue{Kind: tagged.Kind, Value: v}, nil
	case "boolean_list":
		var v []bool
		if err := json.Unmarshal(tagged.Value, &v); err != nil {
			return encodedValue{}, err
		}
		if v == nil {
			v = []bool{}
		}
		return encodedValue{Kind: tagged.Kind, Value: v}, nil
	case "single_select":
		sel, err := selection(tagged.Value)
		if err != nil {
			return encodedValue{}, err
		}
		return encodedValue{Kind: tagged.Kind, Value: sel}, nil
	case "multi_select":
		var items []json.RawMessage
		if err := json.Unmarshal(tagged.Value, &items); err != nil {
			return encodedValue{}, err
		}
		out := make([]fieldSelection, 0, len(items))
		for _, item := range items {
			sel, err := selection(item)
			if err != nil {
				return encodedValue{}, err
			}
			out = append(out, sel)
		}
		return encodedValue{Kind: tagged.Kind, Value: out}, nil
	case "decimal", "decimal_list":
		return encodedValue{}, errors.New("decimal")
	default:
		return encodedValue{}, errors.New("kind")
	}
}

type fieldSelection struct {
	DictionaryValueID int64  `json:"dictionary_value_id"`
	Value             string `json:"value"`
}

func selection(raw json.RawMessage) (fieldSelection, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var sel fieldSelection
	err := dec.Decode(&sel)
	return sel, err
}

func integerValue(raw json.RawMessage) (int64, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var n json.Number
	if err := dec.Decode(&n); err != nil {
		return 0, err
	}
	return n.Int64()
}

// LanguageKey is the field-pack storage key.
func LanguageKey(raw string) (string, bool) {
	switch raw {
	case "default", "ru", "en", "tr", "zh_hans":
		return raw, true
	default:
		return "", false
	}
}
