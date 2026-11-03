package contract

import (
	"bytes"
	"encoding/json"
	"sort"
)

// SameSnapshot compares immutable schema identities while allowing the display
// changes excluded by listing-core's revision hash. Unknown fields stay binding.
func SameSnapshot(a, b []byte) bool {
	x, ok := snapshotIdentity(a)
	if !ok {
		return false
	}
	y, ok := snapshotIdentity(b)
	return ok && bytes.Equal(x, y)
}

func snapshotIdentity(raw []byte) ([]byte, bool) {
	if !json.Valid(raw) {
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var body map[string]any
	if decoder.Decode(&body) != nil {
		return nil, false
	}
	if revision, ok := body["schema_revision"].(string); !ok || revision == "" {
		return nil, false
	}
	fields, ok := body["fields"].([]any)
	if !ok {
		return nil, false
	}
	delete(body, "label")
	seen := map[string]bool{}
	for _, value := range fields {
		field, ok := value.(map[string]any)
		if !ok {
			return nil, false
		}
		key, ok := field["key"].(string)
		if !ok || key == "" || seen[key] {
			return nil, false
		}
		seen[key] = true
		for _, name := range []string{"label", "group", "description", "raw_type"} {
			delete(field, name)
		}
		options, ok := field["options"].([]any)
		if !ok {
			return nil, false
		}
		for _, value := range options {
			option, ok := value.(map[string]any)
			if !ok {
				return nil, false
			}
			if id, ok := option["id"].(string); !ok || id == "" {
				return nil, false
			}
			for _, name := range []string{"value", "info", "picture"} {
				delete(option, name)
			}
		}
		// Keep duplicate option IDs rather than silently changing their meaning.
		sort.Slice(options, func(i, j int) bool {
			a, _ := json.Marshal(options[i])
			b, _ := json.Marshal(options[j])
			return bytes.Compare(a, b) < 0
		})
	}
	sort.Slice(fields, func(i, j int) bool {
		return fields[i].(map[string]any)["key"].(string) < fields[j].(map[string]any)["key"].(string)
	})
	out, err := json.Marshal(body)
	return out, err == nil
}
