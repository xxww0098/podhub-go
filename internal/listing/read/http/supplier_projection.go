package readhttp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

// A linked card stores only seller overrides; each use reads the current supplier config.
func projectSupplierCard(ctx context.Context, tx pgx.Tx, raw []byte, now int64) ([]byte, error) {
	var card map[string]json.RawMessage
	if err := json.Unmarshal(raw, &card); err != nil {
		return nil, err
	}
	var product string
	_ = json.Unmarshal(card["supplierProductId"], &product)
	if product == "" {
		return raw, nil
	}
	facts, err := loadSupplier((&http.Request{}).WithContext(ctx), tx, product, now)
	if err != nil {
		return nil, err
	}
	category, typ, _, _ := categoryOf(raw)
	if facts.missingProduct || facts.missingConfig || facts.denial != "" || facts.category != category || facts.typeID != typ {
		card["supplierUnavailable"] = json.RawMessage(`true`)
		return json.Marshal(card)
	}
	var config, complex, fields []byte
	err = tx.QueryRow(ctx, `SELECT c.values,c.complex_values,cat.fields
 FROM supplier_ozon_configs c JOIN ozon_category_current cat
 ON cat.description_category_id=c.description_category_id AND cat.type_id=c.type_id AND cat.language=c.language
 WHERE c.product_id=$1 FOR SHARE OF c`, product).Scan(&config, &complex, &fields)
	if err != nil {
		return nil, err
	}
	draft, policy, err := supplierDraft(config, complex, fields, card["defaults"])
	if err != nil {
		return nil, err
	}
	card["defaults"], _ = json.Marshal(draft)
	card["aiFieldPolicy"], _ = json.Marshal(policy)
	delete(card, "supplierUnavailable")
	return json.Marshal(card)
}

type supplierField struct {
	Key        string  `json:"key"`
	Editor     string  `json:"editor"`
	Collection bool    `json:"collection"`
	ComplexID  *string `json:"complex_id"`
}
type supplierValue struct {
	Kind    string          `json:"kind"`
	Value   json.RawMessage `json:"value"`
	Options []struct {
		ID    int64  `json:"option_id"`
		Value string `json:"value"`
	} `json:"options"`
}

func supplierDraft(config, complex, fields, overrides []byte) (map[string]any, map[string]any, error) {
	var values map[string][]supplierValue
	var schema []supplierField
	if json.Unmarshal(config, &values) != nil || json.Unmarshal(fields, &schema) != nil {
		return nil, nil, fmt.Errorf("supplier configuration is invalid")
	}
	byKey := map[string]supplierField{}
	for _, f := range schema {
		byKey[f.Key] = f
	}
	plain := map[string]any{}
	for key, entries := range values {
		parts := strings.Split(key, ":")
		fieldKey := ""
		var group int64
		if len(parts) == 2 && parts[0] == "fixed" {
			switch parts[1] {
			case "barcode", "width", "height", "depth", "dimension_unit", "weight", "weight_unit", "vat":
				fieldKey = parts[1]
			}
		}
		if len(parts) == 3 && parts[0] == "attribute" {
			switch parts[1] {
			case "4191", "23171", "9024", "9048", "7109":
				continue
			}
			fieldKey = "attribute_" + parts[1]
			var err error
			group, err = strconv.ParseInt(parts[2], 10, 64)
			if err != nil || group < 0 {
				continue
			}
		}
		field, ok := byKey[fieldKey]
		if !ok {
			continue
		}
		value, err := supplierDraftValue(entries, field)
		if err != nil {
			return nil, nil, err
		}
		if value == nil {
			continue
		}
		if group == 0 {
			plain[fieldKey] = value
		} else {
			return nil, nil, fmt.Errorf("complex supplier values must be grouped into items")
		}
	}
	var groups []struct {
		ID    int64 `json:"complex_id"`
		Items []struct {
			ID     string                     `json:"item_id"`
			Values map[string][]supplierValue `json:"values"`
		} `json:"items"`
	}
	if json.Unmarshal(complex, &groups) != nil {
		return nil, nil, fmt.Errorf("supplier complex configuration is invalid")
	}
	complexDraft := []any{}
	for _, group := range groups {
		// System media comes from confirmed uploads, never supplier defaults.
		if group.ID == 100001 || group.ID == 100002 {
			continue
		}
		items := []any{}
		for _, item := range group.Items {
			values := map[string]any{}
			for key, entries := range item.Values {
				parts := strings.Split(key, ":")
				if len(parts) != 3 || parts[0] != "attribute" || parts[2] != strconv.FormatInt(group.ID, 10) {
					return nil, nil, fmt.Errorf("supplier complex field placement is invalid")
				}
				field, ok := byKey["attribute_"+parts[1]]
				if !ok || field.ComplexID == nil || *field.ComplexID != parts[2] {
					return nil, nil, fmt.Errorf("supplier complex field is not in schema")
				}
				value, err := supplierDraftValue(entries, field)
				if err != nil {
					return nil, nil, err
				}
				if value != nil {
					values[field.Key] = value
				}
			}
			items = append(items, map[string]any{"item_id": item.ID, "values": values})
		}
		complexDraft = append(complexDraft, map[string]any{"complex_id": group.ID, "items": items})
	}
	var own struct {
		Values  map[string]json.RawMessage `json:"values"`
		Cleared []string                   `json:"cleared"`
	}
	if len(overrides) > 0 && json.Unmarshal(overrides, &own) != nil {
		return nil, nil, fmt.Errorf("supplier overrides are invalid")
	}
	for key, value := range own.Values {
		if supplierDefaultKey(key) {
			plain[key] = value
		}
	}
	cleared := []string{}
	for _, key := range own.Cleared {
		if supplierDefaultKey(key) {
			delete(plain, key)
			cleared = append(cleared, key)
		}
	}
	allowed := []string{}
	for _, key := range []string{"name", "attribute_4191", "attribute_23171"} {
		if _, ok := byKey[key]; ok {
			allowed = append(allowed, key)
		}
	}
	return map[string]any{"values": plain, "complex_values": complexDraft, "cleared": cleared}, map[string]any{"allowed_field_keys": allowed, "protected_field_keys": []string{}}, nil
}

func supplierDraftValue(entries []supplierValue, field supplierField) (any, error) {
	if len(entries) == 0 {
		return nil, nil
	}
	kind := entries[0].Kind
	items := []any{}
	for _, entry := range entries {
		if entry.Kind != kind {
			return nil, fmt.Errorf("supplier values have mixed kinds")
		}
		if kind == "options" {
			for _, option := range entry.Options {
				items = append(items, map[string]any{"dictionary_value_id": option.ID, "value": option.Value})
			}
			continue
		}
		var value any
		if json.Unmarshal(entry.Value, &value) != nil {
			return nil, fmt.Errorf("supplier value is invalid")
		}
		if kind == "decimal" {
			var err error
			value, err = strconv.ParseFloat(fmt.Sprint(value), 64)
			if err != nil {
				return nil, err
			}
		}
		items = append(items, value)
	}
	if len(items) == 0 {
		return nil, nil
	}
	if kind == "options" {
		if !field.Collection && len(items) == 1 {
			return map[string]any{"kind": "single_select", "value": items[0]}, nil
		}
		return map[string]any{"kind": "multi_select", "value": items}, nil
	}
	if kind == "flag" {
		kind = "boolean"
	}
	if kind == "text" && (field.Editor == "url" || field.Editor == "url_list") {
		kind = "url"
	}
	if field.Collection || len(items) > 1 {
		return map[string]any{"kind": kind + "_list", "value": items}, nil
	}
	return map[string]any{"kind": kind, "value": items[0]}, nil
}
