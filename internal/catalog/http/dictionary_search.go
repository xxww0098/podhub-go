package cataloghttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/catalog/domain"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

func (h Host) searchDictionary(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.account(w, r); !ok {
		return
	}
	var body struct {
		Attribute int64  `json:"attribute_id"`
		Category  int64  `json:"description_category_id"`
		TypeID    int64  `json:"type_id"`
		Language  string `json:"language"`
		Limit     int64  `json:"limit"`
		Value     string `json:"value"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	dec.DisallowUnknownFields()
	if dec.Decode(&body) != nil || dec.Decode(new(any)) != io.EOF {
		writeErr(w, 400, "字典查询格式无效", "validation")
		return
	}
	body.Value = strings.TrimSpace(body.Value)
	lang, ok := LanguageKey(body.Language)
	if !ok || body.Attribute <= 0 || body.Category <= 0 || body.TypeID <= 0 || body.Limit < 1 || body.Limit > 100 || utf8.RuneCountInString(body.Value) < 2 || utf8.RuneCountInString(body.Value) > 128 {
		writeErr(w, 400, "请选择有效类目与字段，搜索词需为 2–128 个字符", "validation")
		return
	}
	var fields json.RawMessage
	var fetched int64
	err := h.queryOne(r.Context(), `SELECT fields, fetched_at_ms FROM public.ozon_category_current WHERE description_category_id=$1 AND type_id=$2 AND language=$3`, body.Category, body.TypeID, lang, []any{&fields, &fetched})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && !Fresh(h.Now(), fetched) {
		writeErr(w, 409, "请先重新读取该类目的字段", "conflict")
		return
	}
	if err != nil {
		writeErr(w, 500, "类目字段暂时不可用", "internal")
		return
	}
	parsed, err := domain.FieldsFromCache(fields)
	if err != nil {
		writeErr(w, 500, "类目字段无法读取", "internal")
		return
	}
	var dictionary int64
	for _, f := range parsed {
		if f.AttributeID != nil && *f.AttributeID == strconv.FormatInt(body.Attribute, 10) && f.DictionaryID != nil {
			dictionary, _ = strconv.ParseInt(*f.DictionaryID, 10, 64)
		}
	}
	if dictionary <= 0 {
		writeErr(w, 400, "该字段不属于当前类目的字典", "validation")
		return
	}
	keys, err := h.platformKeys(r.Context())
	if err != nil {
		writeErr(w, 500, "平台类目密钥暂时不可用", "internal")
		return
	}
	body.Language = ozonLanguage(lang)
	request, _ := json.Marshal(body)
	for _, key := range keys {
		status, raw, err := h.post(r.Context(), "/v1/description-category/attribute/values/search", request, key.clientID, key.apiKey)
		if err != nil || status != http.StatusOK {
			continue
		}
		options, err := decodeDictionarySearch(raw, int(body.Limit))
		if err != nil {
			continue
		}
		err = h.readIn(r.Context(), func(tx pgx.Tx) error {
			for _, option := range options {
				optionID, _ := strconv.ParseInt(option.ID, 10, 64)
				_, err := tx.Exec(r.Context(), `INSERT INTO public.catalog_dictionary_search_material(description_category_id,type_id,language,attribute_id,dictionary_id,option_id,value) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(description_category_id,type_id,language,attribute_id,dictionary_id,option_id) DO UPDATE SET value=EXCLUDED.value,observed_at=clock_timestamp()`, body.Category, body.TypeID, lang, body.Attribute, dictionary, optionID, option.Value)
				if err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			writeErr(w, 503, "字典结果未能保存，请重试搜索", "internal")
			return
		}
		jsonwire.Write(w, 200, struct {
			Data []domain.FieldOption `json:"data"`
		}{options})
		return
	}
	writeErr(w, 502, "Ozon 字典查询失败，请稍后重试", "internal")
}

func decodeDictionarySearch(raw []byte, limit int) ([]domain.FieldOption, error) {
	var response struct {
		Result json.RawMessage `json:"result"`
	}
	if json.Unmarshal(raw, &response) != nil || len(bytes.TrimSpace(response.Result)) == 0 || bytes.TrimSpace(response.Result)[0] != '[' {
		return nil, errors.New("invalid dictionary response")
	}
	var rows []struct {
		ID      int64  `json:"id"`
		Value   string `json:"value"`
		Info    string `json:"info"`
		Picture string `json:"picture"`
	}
	if json.Unmarshal(response.Result, &rows) != nil || len(rows) > limit {
		return nil, errors.New("invalid dictionary results")
	}
	out := make([]domain.FieldOption, 0, len(rows))
	seen := map[int64]bool{}
	for _, row := range rows {
		if row.ID <= 0 || strings.TrimSpace(row.Value) == "" || seen[row.ID] {
			return nil, errors.New("invalid dictionary option")
		}
		seen[row.ID] = true
		out = append(out, domain.FieldOption{ID: strconv.FormatInt(row.ID, 10), Value: row.Value, Info: row.Info, Picture: row.Picture})
	}
	return out, nil
}
