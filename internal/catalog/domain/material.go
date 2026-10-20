package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
)

// SemanticRevision is semantic_schema_revision for recipe and catalog version 0.
// The hashed JSON is serde struct order, option ids sorted, aspect always present.
func SemanticRevision(category, typeID int64, fields []ListingField) string {
	idents := make([]semanticField, len(fields))
	for i, field := range fields {
		ids := append([]string(nil), field.OptionIDs...)
		if ids == nil {
			ids = []string{}
		}
		sortStrings(ids)
		idents[i] = semanticField{
			Key: field.Key, Editor: field.Editor, Required: field.Required,
			Collection: field.Collection, Max: field.MaxValueCount, Dictionary: field.DictionaryID,
			Attribute: field.AttributeID, Complex: field.ComplexID,
			ComplexGroup: field.ComplexGroupCollection, ReadOnly: field.ReadOnly,
			Aspect: field.Aspect, OptionIDs: ids, Truncated: field.OptionsTruncated,
		}
	}
	groups := complexGroups(fields)
	raw, err := json.Marshal(semanticMaterial{
		SchemaFormat: 2, Normalization: 1, Validation: 1, Serializer: 1,
		Category: category, TypeID: typeID, Recipe: 0, RecipeRevision: 0, CatalogVersion: 0,
		Fields: idents, Groups: groups,
	})
	if err != nil {
		return "sha256:"
	}
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// ListingField is the native field a snapshot hashes and serves.
type ListingField struct {
	Key                    string
	Label                  string
	Group                  string
	Editor                 string
	Required               bool
	Collection             bool
	MaxValueCount          *uint32
	DictionaryID           *string
	AttributeID            *string
	ComplexID              *string
	Description            string
	RawType                *string
	ReadOnly               bool
	ComplexGroupCollection bool
	Options                []FieldOption
	OptionsTruncated       bool
	Aspect                 *bool
	OptionIDs              []string
}

// FieldOption is one inline dictionary value.
type FieldOption struct {
	ID      string `json:"id"`
	Value   string `json:"value"`
	Info    string `json:"info"`
	Picture string `json:"picture"`
}

type semanticField struct {
	Key          string   `json:"key"`
	Editor       string   `json:"editor"`
	Required     bool     `json:"required"`
	Collection   bool     `json:"collection"`
	Max          *uint32  `json:"max_value_count,omitempty"`
	Dictionary   *string  `json:"dictionary_id,omitempty"`
	Attribute    *string  `json:"attribute_id,omitempty"`
	Complex      *string  `json:"complex_id,omitempty"`
	ComplexGroup bool     `json:"complex_group_collection"`
	ReadOnly     bool     `json:"read_only"`
	Aspect       *bool    `json:"aspect"`
	OptionIDs    []string `json:"option_ids"`
	Truncated    bool     `json:"options_truncated"`
}

type semanticGroup struct {
	ComplexID  int64    `json:"complex_id"`
	Collection bool     `json:"collection"`
	FieldKeys  []string `json:"field_keys"`
}

type semanticMaterial struct {
	SchemaFormat   uint32          `json:"schema_format_version"`
	Normalization  uint32          `json:"normalization_ruleset_version"`
	Validation     uint32          `json:"validation_ruleset_version"`
	Serializer     uint32          `json:"serializer_ruleset_version"`
	Category       int64           `json:"description_category_id"`
	TypeID         int64           `json:"type_id"`
	Recipe         int64           `json:"recipe_id"`
	RecipeRevision int64           `json:"recipe_revision"`
	CatalogVersion uint32          `json:"catalog_schema_version"`
	Fields         []semanticField `json:"fields"`
	Groups         []semanticGroup `json:"complex_groups"`
}

func complexGroups(fields []ListingField) []semanticGroup {
	order := []int64{}
	byID := map[int64]*semanticGroup{}
	for _, field := range fields {
		if field.ComplexID == nil {
			continue
		}
		id, err := strconv.ParseInt(*field.ComplexID, 10, 64)
		if err != nil {
			continue
		}
		group := byID[id]
		if group == nil {
			group = &semanticGroup{ComplexID: id, FieldKeys: []string{}}
			byID[id] = group
			order = append(order, id)
		}
		group.Collection = group.Collection || field.ComplexGroupCollection
		group.FieldKeys = append(group.FieldKeys, field.Key)
	}
	out := make([]semanticGroup, 0, len(order))
	sorted := append([]int64(nil), order...)
	sortInt64(sorted)
	for _, id := range sorted {
		out = append(out, *byID[id])
	}
	if out == nil {
		out = []semanticGroup{}
	}
	return out
}

func sortStrings(in []string) {
	for i := 1; i < len(in); i++ {
		j := i
		for j > 0 && in[j] < in[j-1] {
			in[j], in[j-1] = in[j-1], in[j]
			j--
		}
	}
}

func sortInt64(in []int64) {
	for i := 1; i < len(in); i++ {
		j := i
		for j > 0 && in[j] < in[j-1] {
			in[j], in[j-1] = in[j-1], in[j]
			j--
		}
	}
}

// LiveFixedFields is live_fixed_fields().
func LiveFixedFields() []ListingField {
	type row struct {
		key, label, editor string
		required, readOnly bool
	}
	rows := []row{
		{"offer_id", "Offer ID", "text", true, false},
		{"name", "Name", "text", true, false},
		{"price", "Price", "decimal", true, false},
		{"description_category_id", "Description category", "integer", true, true},
		{"type_id", "Product type", "integer", true, true},
		{"barcode", "Barcode", "text", false, false},
		{"width", "Width", "integer", true, false},
		{"height", "Height", "integer", true, false},
		{"depth", "Depth", "integer", true, false},
		{"dimension_unit", "Dimension unit", "text", true, false},
		{"weight", "Weight", "integer", true, false},
		{"weight_unit", "Weight unit", "text", true, false},
		{"images", "Images", "url_list", true, false},
		{"images360", "360 images", "url_list", false, false},
		{"primary_image", "Primary image", "url", false, false},
		{"color_image", "Color image", "url", false, false},
		{"currency_code", "Currency", "text", false, false},
		{"old_price", "Old price", "decimal", false, false},
		{"vat", "VAT", "decimal", true, false},
	}
	out := make([]ListingField, 0, len(rows))
	for _, item := range rows {
		field := ListingField{
			Key: item.key, Label: item.label, Group: "Fixed", Editor: item.editor,
			Required: item.required, ReadOnly: item.readOnly, Options: []FieldOption{}, OptionIDs: []string{},
		}
		field.Collection = item.editor == "url_list"
		if item.key == "images" || item.key == "images360" {
			n := uint32(15)
			field.MaxValueCount = &n
		}
		out = append(out, field)
	}
	return out
}

// InferEditor matches infer_editor.
func InferEditor(rawType string, collection, hasDictionary, truncated bool) string {
	normalized := stringsToLower(rawType)
	var scalar string
	switch normalized {
	case "integer", "int", "int32", "int64", "long":
		scalar = "integer"
	case "decimal", "float", "double", "number", "numeric":
		scalar = "decimal"
	case "boolean", "bool":
		scalar = "boolean"
	case "url", "uri", "link":
		scalar = "url"
	case "url_list", "urls", "uri_list", "link_list":
		scalar = "url_list"
	case "enum", "enumeration", "select", "dictionary":
		scalar = "single_select"
	case "multiselect", "multi_select", "multi_enum", "enum_list":
		scalar = "multi_select"
	case "string", "text", "char", "textarea", "rich_text", "richtext":
		scalar = "text"
	default:
		return "text"
	}
	if hasDictionary {
		if truncated {
			return "dictionary_search"
		}
		if collection {
			return "multi_select"
		}
		return "single_select"
	}
	if collection {
		switch scalar {
		case "url", "url_list":
			return "url_list"
		case "multi_select", "single_select":
			return "multi_select"
		default:
			return scalar
		}
	}
	return scalar
}

func stringsToLower(raw string) string {
	start, end := 0, len(raw)
	for start < end && (raw[start] == ' ' || raw[start] == '\t' || raw[start] == '\n') {
		start++
	}
	for end > start && (raw[end-1] == ' ' || raw[end-1] == '\t' || raw[end-1] == '\n') {
		end--
	}
	out := make([]byte, 0, end-start)
	for i := start; i < end; i++ {
		c := raw[i]
		if c == '-' || c == ' ' {
			out = append(out, '_')
			continue
		}
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		out = append(out, c)
	}
	return string(out)
}

// SnapshotMaterial is nativeMaterial for one served field list.
type SnapshotMaterial struct {
	Snapshot        snapshotWire `json:"snapshot"`
	SearchMaterials []SearchHit  `json:"search_materials"`
}

type snapshotWire struct {
	CategoryKey    string      `json:"category_key"`
	Label          string      `json:"label"`
	Category       int64       `json:"description_category_id"`
	TypeID         int64       `json:"type_id"`
	SchemaRevision string      `json:"schema_revision"`
	RecipeID       int64       `json:"recipe_id"`
	RecipeRevision int64       `json:"recipe_revision"`
	CatalogVersion uint32      `json:"catalog_schema_version"`
	Fields         []wireField `json:"fields"`
}

type wireField struct {
	Key          string        `json:"key"`
	Label        string        `json:"label"`
	Group        string        `json:"group"`
	Editor       string        `json:"editor"`
	Required     bool          `json:"required"`
	Constraints  wireLimits    `json:"constraints"`
	AttributeID  *string       `json:"attribute_id"`
	ComplexID    *string       `json:"complex_id"`
	Description  string        `json:"description"`
	RawType      *string       `json:"raw_type"`
	ReadOnly     bool          `json:"read_only"`
	ComplexGroup bool          `json:"complex_group_collection"`
	Options      []FieldOption `json:"options"`
	Truncated    bool          `json:"options_truncated"`
	Aspect       *bool         `json:"aspect"`
}

type wireLimits struct {
	Collection bool    `json:"collection"`
	Max        *uint32 `json:"max_value_count,omitempty"`
	Dictionary *string `json:"dictionary_id,omitempty"`
}

// SearchHit is one Seller-confirmed dictionary value.
type SearchHit struct {
	DescriptionCategoryID int64  `json:"description_category_id"`
	AttributeID           int64  `json:"attribute_id"`
	DictionaryID          int64  `json:"dictionary_id"`
	ValueID               int64  `json:"value_id"`
	Label                 string `json:"label"`
}

// MaterialFromFields builds nativeMaterial. search is appended as given.
func MaterialFromFields(category, typeID int64, fields []ListingField, search []SearchHit) SnapshotMaterial {
	if search == nil {
		search = []SearchHit{}
	}
	rev := SemanticRevision(category, typeID, fields)
	wire := make([]wireField, len(fields))
	for i, field := range fields {
		options := field.Options
		if options == nil {
			options = []FieldOption{}
		}
		wire[i] = wireField{
			Key: field.Key, Label: field.Label, Group: field.Group, Editor: field.Editor, Required: field.Required,
			Constraints: wireLimits{Collection: field.Collection, Max: field.MaxValueCount, Dictionary: field.DictionaryID},
			AttributeID: field.AttributeID, ComplexID: field.ComplexID, Description: field.Description,
			RawType: field.RawType, ReadOnly: field.ReadOnly, ComplexGroup: field.ComplexGroupCollection,
			Options: options, Truncated: field.OptionsTruncated, Aspect: field.Aspect,
		}
	}
	return SnapshotMaterial{
		Snapshot: snapshotWire{
			CategoryKey: fmt.Sprintf("workflow:%d:%d", category, typeID),
			Label:       fmt.Sprintf("Ozon %d / %d", category, typeID),
			Category:    category, TypeID: typeID,
			SchemaRevision: "workflow:" + rev,
			Fields:         wire,
		},
		SearchMaterials: search,
	}
}

// FieldsFromCache decodes a cached CatalogSchemaField array into listing fields.
// Extra or missing keys stay zero. The stored bytes are not rewritten.
func FieldsFromCache(raw json.RawMessage) ([]ListingField, error) {
	var rows []cachedField
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, err
	}
	out := make([]ListingField, 0, len(rows))
	for _, row := range rows {
		options := make([]FieldOption, 0, len(row.Options))
		ids := make([]string, 0, len(row.Options))
		for _, opt := range row.Options {
			options = append(options, FieldOption{ID: opt.ID, Value: opt.Value, Info: opt.Info, Picture: opt.Picture})
			ids = append(ids, opt.ID)
		}
		editor := row.Editor
		out = append(out, ListingField{
			Key: row.Key, Label: row.Label, Group: row.Group, Editor: editor, Required: row.Required,
			Collection: row.Collection, MaxValueCount: row.Max, DictionaryID: row.Dictionary,
			AttributeID: row.Attribute, ComplexID: row.Complex, Description: row.Description,
			RawType: row.RawType, ReadOnly: row.ReadOnly, ComplexGroupCollection: row.ComplexGroup,
			Options: options, OptionsTruncated: row.Truncated, Aspect: row.Aspect, OptionIDs: ids,
		})
	}
	return out, nil
}

type cachedField struct {
	Key          string        `json:"key"`
	Label        string        `json:"label"`
	Group        string        `json:"group"`
	Editor       string        `json:"editor"`
	Required     bool          `json:"required"`
	Collection   bool          `json:"collection"`
	Max          *uint32       `json:"max_value_count"`
	Dictionary   *string       `json:"dictionary_id"`
	Attribute    *string       `json:"attribute_id"`
	Complex      *string       `json:"complex_id"`
	Description  string        `json:"description"`
	RawType      *string       `json:"raw_type"`
	ReadOnly     bool          `json:"read_only"`
	ComplexGroup bool          `json:"complex_group_collection"`
	Options      []FieldOption `json:"options"`
	Truncated    bool          `json:"options_truncated"`
	Aspect       *bool         `json:"aspect"`
}

// NoBrandAttribute is attribute 85. NoBrandValueID and NoBrandLabel are the
// fixed picker row for a truncated brand dictionary.
const (
	NoBrandAttribute = "85"
	NoBrandValueID   = int64(126745801)
	NoBrandLabel     = "Нет бренда"
)
