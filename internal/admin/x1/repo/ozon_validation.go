package x1repo

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	x1 "github.com/xxww0098/podhub-go/internal/admin/x1/contract"
)

var errConfigValidator = errors.New("supplier config validation is unavailable")

func (r X1) judgeOzon(ctx context.Context, tx pgx.Tx, category, typ int64, language string, values, complex []byte, stamp x1.CatalogStamp, now int64) (x1.JudgeResult, error) {
	if !stamp.Present || stamp.Digest == "" || x1.Freshness(stamp.Fetched, now, true) == "expired" {
		return x1.Judge(nil, stamp, now), nil
	}
	if r.ValidateConfig == nil || len(stamp.Fields) == 0 {
		return x1.JudgeResult{}, corerepo.MapDB(errConfigValidator)
	}
	search := []map[string]any{}
	rows, err := tx.Query(ctx, `SELECT attribute_id,dictionary_id,option_id,value FROM public.catalog_dictionary_search_material WHERE description_category_id=$1 AND type_id=$2 AND language=$3`, category, typ, language)
	if err != nil {
		return x1.JudgeResult{}, corerepo.MapDB(err)
	}
	for rows.Next() {
		var attr, dict, id int64
		var label string
		if err = rows.Scan(&attr, &dict, &id, &label); err != nil {
			rows.Close()
			return x1.JudgeResult{}, corerepo.MapDB(err)
		}
		search = append(search, map[string]any{"descriptionCategoryId": category, "attributeId": attr, "dictionaryId": dict, "valueId": id, "label": label})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return x1.JudgeResult{}, corerepo.MapDB(err)
	}
	// The fixed no-brand choice is the same Seller ID the catalog endpoint serves.
	var fields []struct {
		Attribute  *string `json:"attribute_id"`
		Dictionary *string `json:"dictionary_id"`
	}
	if err = json.Unmarshal(stamp.Fields, &fields); err != nil {
		return x1.JudgeResult{}, corerepo.MapDB(err)
	}
	for _, field := range fields {
		if field.Attribute != nil && field.Dictionary != nil && *field.Attribute == "85" {
			search = append(search, map[string]any{"descriptionCategoryId": category, "attributeId": 85, "dictionaryId": json.Number(*field.Dictionary), "valueId": 126745801, "label": "Нет бренда"})
		}
	}
	material := jsonBytes(map[string]any{"description_category_id": category, "type_id": typ, "fields": stamp.Fields, "searchMaterials": search})
	config := jsonBytes(map[string]any{"values": json.RawMessage(rawOr(values, `{}`)), "complex_values": json.RawMessage(rawOr(complex, `[]`))})
	issues, err := r.ValidateConfig(ctx, material, config)
	if err != nil {
		return x1.JudgeResult{}, err
	}
	var verified []json.RawMessage
	if json.Unmarshal(issues, &verified) != nil || verified == nil {
		return x1.JudgeResult{}, corerepo.MapDB(errConfigValidator)
	}
	return x1.Judge(issues, stamp, now), nil
}
