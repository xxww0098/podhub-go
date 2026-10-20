package core

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
)

// orderIndependentSnapshot hashes fields sorted by attribute id, then puts
// the snapshot's fields array back in the cache's display order. The wasm
// bytes are unchanged: snapshot_from_fields still hashes the order it is given.
func (m *Module) orderIndependentSnapshot(ctx context.Context, raw []byte) ([]byte, error) {
	sorted, perm, ok := sortFieldsForRevision(raw)
	if !ok {
		return m.snapshotWasm(ctx, raw)
	}
	out, err := m.snapshotWasm(ctx, sorted)
	if err != nil {
		return nil, err
	}
	restored, ok := restoreDisplayOrder(out, perm)
	if !ok {
		return out, nil
	}
	return restored, nil
}

type attrKey struct {
	id  string
	n   int64
	num bool
	ok  bool
	key string
	idx int
}

func sortFieldsForRevision(raw []byte) (sorted []byte, perm []int, ok bool) {
	var env map[string]json.RawMessage
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, nil, false
	}
	fieldsRaw, exists := env["fields"]
	if !exists {
		return nil, nil, false
	}
	var fields []json.RawMessage
	if err := json.Unmarshal(fieldsRaw, &fields); err != nil || len(fields) == 0 {
		return nil, nil, false
	}
	keys := make([]attrKey, len(fields))
	for i, field := range fields {
		keys[i] = fieldSortKey(field, i)
	}
	order := make([]int, len(fields))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool {
		return lessAttr(keys[order[a]], keys[order[b]])
	})
	sortedFields := make([]json.RawMessage, len(fields))
	perm = make([]int, len(fields))
	for i, src := range order {
		sortedFields[i] = fields[src]
		perm[i] = src
	}
	encoded, err := marshalJSON(sortedFields)
	if err != nil {
		return nil, nil, false
	}
	env["fields"] = encoded
	out, err := marshalJSON(env)
	if err != nil {
		return nil, nil, false
	}
	return out, perm, true
}

func fieldSortKey(field json.RawMessage, idx int) attrKey {
	var probe struct {
		Key string `json:"key"`
		ID  any    `json:"attribute_id"`
	}
	_ = json.Unmarshal(field, &probe)
	k := attrKey{key: probe.Key, idx: idx}
	switch v := probe.ID.(type) {
	case string:
		if v != "" {
			k.id = v
			k.ok = true
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				k.n = n
				k.num = true
			}
		}
	case float64:
		k.n = int64(v)
		k.num = true
		k.ok = true
		k.id = strconv.FormatInt(k.n, 10)
	}
	return k
}

func lessAttr(a, b attrKey) bool {
	if a.ok != b.ok {
		return a.ok
	}
	if a.ok && b.ok {
		if a.num && b.num && a.n != b.n {
			return a.n < b.n
		}
		if a.id != b.id {
			return a.id < b.id
		}
	}
	if a.key != b.key {
		return a.key < b.key
	}
	return a.idx < b.idx
}

// restoreDisplayOrder puts snapshot fields back in the pre-sort order.
// perm[i] is the original index of the field now at position i.
func restoreDisplayOrder(snapshot []byte, perm []int) ([]byte, bool) {
	var env map[string]json.RawMessage
	if err := json.Unmarshal(snapshot, &env); err != nil {
		return nil, false
	}
	var fields []json.RawMessage
	if err := json.Unmarshal(env["fields"], &fields); err != nil || len(fields) != len(perm) {
		return nil, false
	}
	restored := make([]json.RawMessage, len(fields))
	for i, orig := range perm {
		if orig < 0 || orig >= len(restored) || restored[orig] != nil {
			return nil, false
		}
		restored[orig] = fields[i]
	}
	encoded, err := marshalJSON(restored)
	if err != nil {
		return nil, false
	}
	out, ok := spliceJSONArray(snapshot, "fields", encoded)
	if !ok {
		return nil, false
	}
	return out, true
}

func schemaRevisionOf(snapshot []byte) (string, bool) {
	var rev struct {
		Revision string `json:"schema_revision"`
	}
	if err := json.Unmarshal(snapshot, &rev); err != nil || rev.Revision == "" {
		return "", false
	}
	return rev.Revision, true
}

func marshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// spliceJSONArray replaces the first top-level array named key, keeping the
// rest of the wasm snapshot bytes (including schema_revision) as they were.
func spliceJSONArray(doc []byte, key string, replacement []byte) ([]byte, bool) {
	needle := []byte(`"` + key + `":`)
	i := bytes.Index(doc, needle)
	if i < 0 {
		return nil, false
	}
	j := i + len(needle)
	for j < len(doc) && (doc[j] == ' ' || doc[j] == '\n' || doc[j] == '\t') {
		j++
	}
	if j >= len(doc) || doc[j] != '[' {
		return nil, false
	}
	end, ok := scanJSONValue(doc, j)
	if !ok {
		return nil, false
	}
	out := make([]byte, 0, len(doc)-(end-j)+len(replacement))
	out = append(out, doc[:j]...)
	out = append(out, replacement...)
	out = append(out, doc[end:]...)
	return out, true
}

func scanJSONValue(doc []byte, start int) (int, bool) {
	if start >= len(doc) {
		return 0, false
	}
	switch doc[start] {
	case '{', '[':
		open := doc[start]
		close := byte('}')
		if open == '[' {
			close = ']'
		}
		depth := 0
		inStr := false
		esc := false
		for i := start; i < len(doc); i++ {
			c := doc[i]
			if inStr {
				if esc {
					esc = false
					continue
				}
				if c == '\\' {
					esc = true
					continue
				}
				if c == '"' {
					inStr = false
				}
				continue
			}
			switch c {
			case '"':
				inStr = true
			case open:
				depth++
			case close:
				depth--
				if depth == 0 {
					return i + 1, true
				}
			}
		}
		return 0, false
	default:
		return 0, false
	}
}

// fieldKeys reads snapshot field keys in array order. Used by tests via the
// same package. Exported through the test file only.
func snapshotFieldKeys(snapshot []byte) ([]string, error) {
	var env struct {
		Fields []struct {
			Key string `json:"key"`
		} `json:"fields"`
	}
	if err := json.Unmarshal(snapshot, &env); err != nil {
		return nil, err
	}
	out := make([]string, len(env.Fields))
	for i, field := range env.Fields {
		out[i] = field.Key
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("snapshot has no fields")
	}
	return out, nil
}
