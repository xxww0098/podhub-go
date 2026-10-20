package submit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

// schemaField is the part of a category field that moves a schema revision.
// Labels and group names are display and are not compared.
type schemaField struct {
	Key                    string
	AttributeID            string
	Editor                 string
	Required               bool
	Collection             bool
	Max                    *uint32
	DictionaryID           string
	ComplexID              string
	ComplexGroupCollection bool
	ReadOnly               bool
	Aspect                 *bool
	OptionIDs              []string
	OptionsTruncated       bool
}

// schemaDecision is the one send rule. The browser is given the same answer
// (accepted revisions, or the field list) and does not refuse on its own.
// Rebind is written onto the row before freeze so the wasm equality check
// follows this decision instead of rejecting schema_stale by itself.
type schemaDecision struct {
	Rebind string
	Block  []string
	Record bool
}

// decideSchema decides whether a stored revision may be sent.
//
// current is the order-independent revision. legacy is the order-sensitive
// hash of the cache's current field order (what older rows stored). A stored value
// that equals either is unchanged.
//
// When neither matches, the row is rebound to current and validation runs.
// The send stops only when a field is required now, was not required before,
// and the product has no value for it. Order-only differences do not record
// a new schema revision row. before == nil means the previous snapshot is
// not in listing_schema_revisions; that is not treated as a new required
// field and is not recorded, so a cache refresh that only reordered fields
// cannot mint a revision row.
func decideSchema(stored, current, legacy string, before, after []schemaField, filled map[string]bool) schemaDecision {
	if stored == current || stored == legacy || orderOnly(before, after) {
		return schemaDecision{Rebind: current}
	}
	missing := newlyRequiredUnsatisfied(before, after, filled)
	if len(missing) > 0 {
		return schemaDecision{Block: missing, Record: semanticChange(before, after)}
	}
	return schemaDecision{Rebind: current, Record: semanticChange(before, after)}
}

func orderOnly(before, after []schemaField) bool {
	return before != nil && after != nil && semanticEqual(before, after)
}

func semanticChange(before, after []schemaField) bool {
	return before != nil && after != nil && !semanticEqual(before, after)
}

func semanticEqual(before, after []schemaField) bool {
	if len(before) != len(after) {
		return false
	}
	a := append([]schemaField(nil), before...)
	b := append([]schemaField(nil), after...)
	sort.Slice(a, func(i, j int) bool { return a[i].Key < a[j].Key })
	sort.Slice(b, func(i, j int) bool { return b[i].Key < b[j].Key })
	for i := range a {
		if !sameField(a[i], b[i]) {
			return false
		}
	}
	return true
}

func sameField(a, b schemaField) bool {
	if a.Key != b.Key || a.AttributeID != b.AttributeID || a.Editor != b.Editor || a.Required != b.Required ||
		a.Collection != b.Collection || a.DictionaryID != b.DictionaryID || a.ComplexID != b.ComplexID ||
		a.ComplexGroupCollection != b.ComplexGroupCollection || a.ReadOnly != b.ReadOnly || a.OptionsTruncated != b.OptionsTruncated {
		return false
	}
	if (a.Max == nil) != (b.Max == nil) || (a.Max != nil && *a.Max != *b.Max) {
		return false
	}
	if (a.Aspect == nil) != (b.Aspect == nil) || (a.Aspect != nil && *a.Aspect != *b.Aspect) {
		return false
	}
	if len(a.OptionIDs) != len(b.OptionIDs) {
		return false
	}
	for i := range a.OptionIDs {
		if a.OptionIDs[i] != b.OptionIDs[i] {
			return false
		}
	}
	return true
}

// newlyRequiredUnsatisfied lists field keys that became required and have
// no value on the product. Already-required fields are left to validation.
func newlyRequiredUnsatisfied(before, after []schemaField, filled map[string]bool) []string {
	if before == nil {
		return nil
	}
	prev := make(map[string]schemaField, len(before))
	for _, field := range before {
		prev[field.Key] = field
	}
	var missing []string
	for _, field := range after {
		if !field.Required {
			continue
		}
		old, ok := prev[field.Key]
		if ok && old.Required {
			continue
		}
		if filled[field.Key] {
			continue
		}
		missing = append(missing, field.Key)
	}
	sort.Strings(missing)
	return missing
}

func parseSchemaFields(raw json.RawMessage) ([]schemaField, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var asArray []json.RawMessage
	if err := json.Unmarshal(raw, &asArray); err != nil {
		var wrap struct {
			Fields json.RawMessage `json:"fields"`
		}
		if err := json.Unmarshal(raw, &wrap); err != nil || len(wrap.Fields) == 0 {
			return nil, err
		}
		if err := json.Unmarshal(wrap.Fields, &asArray); err != nil {
			return nil, err
		}
	}
	out := make([]schemaField, 0, len(asArray))
	for _, item := range asArray {
		field, err := parseSchemaField(item)
		if err != nil {
			return nil, err
		}
		out = append(out, field)
	}
	return out, nil
}

func parseSchemaField(raw json.RawMessage) (schemaField, error) {
	var body struct {
		Key                    string  `json:"key"`
		Editor                 string  `json:"editor"`
		Required               bool    `json:"required"`
		Collection             bool    `json:"collection"`
		Max                    *uint32 `json:"max_value_count"`
		DictionaryID           *string `json:"dictionary_id"`
		AttributeID            *string `json:"attribute_id"`
		ComplexID              *string `json:"complex_id"`
		ReadOnly               bool    `json:"read_only"`
		ComplexGroupCollection bool    `json:"complex_group_collection"`
		OptionsTruncated       bool    `json:"options_truncated"`
		Aspect                 *bool   `json:"aspect"`
		Options                []struct {
			ID string `json:"id"`
		} `json:"options"`
		Constraints *struct {
			Collection   bool    `json:"collection"`
			Max          *uint32 `json:"max_value_count"`
			DictionaryID *string `json:"dictionary_id"`
		} `json:"constraints"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return schemaField{}, err
	}
	field := schemaField{
		Key: body.Key, Editor: body.Editor, Required: body.Required,
		Collection: body.Collection, Max: body.Max, ReadOnly: body.ReadOnly,
		ComplexGroupCollection: body.ComplexGroupCollection,
		OptionsTruncated:       body.OptionsTruncated, Aspect: body.Aspect,
	}
	if body.DictionaryID != nil {
		field.DictionaryID = *body.DictionaryID
	}
	if body.AttributeID != nil {
		field.AttributeID = *body.AttributeID
	}
	if body.ComplexID != nil {
		field.ComplexID = *body.ComplexID
	}
	if body.Constraints != nil {
		field.Collection = body.Constraints.Collection
		field.Max = body.Constraints.Max
		if body.Constraints.DictionaryID != nil {
			field.DictionaryID = *body.Constraints.DictionaryID
		}
	}
	ids := make([]string, 0, len(body.Options))
	for _, option := range body.Options {
		if option.ID != "" {
			ids = append(ids, option.ID)
		}
	}
	sort.Strings(ids)
	field.OptionIDs = ids
	return field, nil
}

// filledFieldKeys reports draft values the product actually has.
// Boolean false and integer 0 count. Cleared keys do not.
func filledFieldKeys(raw []byte) map[string]bool {
	var body struct {
		Draft struct {
			Values  map[string]json.RawMessage `json:"values"`
			Cleared []string                   `json:"cleared"`
			Complex []struct {
				Items []struct {
					Values map[string]json.RawMessage `json:"values"`
				} `json:"items"`
			} `json:"complex_values"`
		} `json:"draft"`
		Values map[string]json.RawMessage `json:"values"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil
	}
	out := map[string]bool{}
	for key, value := range body.Values {
		if valueFilled(value) {
			out[key] = true
		}
	}
	for key, value := range body.Draft.Values {
		if valueFilled(value) {
			out[key] = true
		}
	}
	for _, group := range body.Draft.Complex {
		for _, item := range group.Items {
			for key, value := range item.Values {
				if valueFilled(value) {
					out[key] = true
				}
			}
		}
	}
	for _, key := range body.Draft.Cleared {
		delete(out, key)
	}
	return out
}

func valueFilled(raw json.RawMessage) bool {
	if len(bytes.TrimSpace(raw)) == 0 || string(raw) == "null" {
		return false
	}
	var probe struct {
		Kind  string          `json:"kind"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return false
	}
	if probe.Kind == "" {
		text := strings.TrimSpace(string(raw))
		return text != `""` && text != "null" && text != "[]" && text != "{}"
	}
	if len(probe.Value) == 0 || string(probe.Value) == "null" {
		return false
	}
	switch probe.Kind {
	case "text", "url":
		var s string
		if err := json.Unmarshal(probe.Value, &s); err != nil {
			return false
		}
		return strings.TrimSpace(s) != ""
	case "text_list", "url_list", "integer_list", "decimal_list", "boolean_list", "multi_select":
		var arr []json.RawMessage
		if err := json.Unmarshal(probe.Value, &arr); err != nil {
			return false
		}
		return len(arr) > 0
	default:
		return true
	}
}

func bindSchemaRevision(raw []byte, revision string) ([]byte, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(revision)
	if err != nil {
		return nil, err
	}
	obj["schemaRevision"] = encoded
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(obj); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func previousSchemaFields(ctx context.Context, tx pgx.Tx, revision string) ([]schemaField, error) {
	if revision == "" || tx == nil {
		return nil, nil
	}
	var snap []byte
	err := tx.QueryRow(ctx, `
		SELECT snapshot FROM public.listing_schema_revisions
		 WHERE schema_revision = $1`, revision).Scan(&snap)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return parseSchemaFields(snap)
}

// noteSchemaRevision inserts the canonical snapshot once. A repeat of the
// same revision, including a later cache refresh that only reordered fields,
// writes nothing.
func noteSchemaRevision(ctx context.Context, tx pgx.Tx, revision string, snapshot []byte) error {
	if revision == "" || tx == nil {
		return nil
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO public.listing_schema_revisions (schema_revision, snapshot)
		VALUES ($1, $2::jsonb)
		ON CONFLICT (schema_revision) DO NOTHING`, revision, snapshot)
	return err
}

func requiredFieldNames(issues json.RawMessage) []string {
	if len(issues) == 0 || string(issues) == "null" {
		return nil
	}
	var rows []struct {
		Key  string `json:"field_key"`
		Code string `json:"code"`
	}
	if err := json.Unmarshal(issues, &rows); err != nil {
		return nil
	}
	var names []string
	seen := map[string]bool{}
	for _, row := range rows {
		if row.Code == "required" && row.Key != "" && !seen[row.Key] {
			seen[row.Key] = true
			names = append(names, row.Key)
		}
	}
	sort.Strings(names)
	return names
}

func acceptedRevisions(current, legacy string) []string {
	if current == "" {
		return nil
	}
	if legacy == "" || legacy == current {
		return []string{current}
	}
	return []string{current, legacy}
}
