package cataloghttp

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/catalog/domain"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

var (
	inflightMu sync.Mutex
	inflight   = map[string]struct{}{}

	negativeMu sync.Mutex
	negative   = map[string]time.Time{}
)

func claimToken(token string) (func(), bool) {
	inflightMu.Lock()
	defer inflightMu.Unlock()
	if _, ok := inflight[token]; ok {
		return nil, false
	}
	inflight[token] = struct{}{}
	return func() {
		inflightMu.Lock()
		delete(inflight, token)
		inflightMu.Unlock()
	}, true
}

func negativeRecent(key string, now time.Time) bool {
	negativeMu.Lock()
	defer negativeMu.Unlock()
	at, ok := negative[key]
	if !ok {
		return false
	}
	if now.Sub(at) < 60*time.Second {
		return true
	}
	delete(negative, key)
	return false
}

func negativeRecord(key string, now time.Time) {
	negativeMu.Lock()
	defer negativeMu.Unlock()
	if len(negative) >= 10000 {
		negative = map[string]time.Time{}
	}
	negative[key] = now
}

func (h Host) fillTree(w http.ResponseWriter, r *http.Request, p access.Principal, language, storeID string) {
	release, ok := claimToken("tree:" + language)
	if !ok {
		w.Header().Set("Retry-After", "3")
		writeErr(w, http.StatusServiceUnavailable, "类目数据正在读取，请稍后重试", "internal")
		return
	}
	defer release()
	clientID, apiKey, fail := h.storeCredential(r, p.OrgID, storeID)
	if fail != nil {
		writeErr(w, fail.status, fail.message, fail.code)
		return
	}
	body := []byte(`{}`)
	if lang := ozonLanguage(language); lang != "" {
		raw, _ := json.Marshal(struct {
			Language string `json:"language"`
		}{Language: lang})
		body = raw
	}
	status, resp, err := h.post(r.Context(), "/v1/description-category/tree", body, clientID, apiKey)
	if err != nil {
		writeSellerErr(w, err, false)
		return
	}
	if status < 200 || status >= 300 {
		writeErr(w, http.StatusBadGateway, "类目树读取失败，请稍后重试", "internal")
		return
	}
	nodes, err := cacheNodes(resp)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "类目树读取失败，请稍后重试", "internal")
		return
	}
	raw, err := json.Marshal(nodes)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	gz, err := gzipBytes(raw)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	now := h.Now().UnixMilli()
	if _, err := h.Pool.Exec(r.Context(), `
		INSERT INTO public.ozon_catalog_tree_cache (language, payload, fetched_at_ms, byte_size, updated_at)
		VALUES ($1, $2, $3, $4, clock_timestamp())
		ON CONFLICT (language) DO UPDATE
		SET payload = EXCLUDED.payload,
		    fetched_at_ms = EXCLUDED.fetched_at_ms,
		    byte_size = EXCLUDED.byte_size,
		    updated_at = clock_timestamp()`, language, gz, now, len(gz)); err != nil {
		slog.Error("catalog tree cache", "err", err)
	}
	jsonwire.Write(w, http.StatusOK, &TreeData{Language: language, FetchedAtMs: now, Items: domain.FlattenTree(nodes)})
}

type credFail struct {
	status        int
	message, code string
}

func (h Host) storeCredential(r *http.Request, org int64, storeID string) (string, string, *credFail) {
	var env seal.Store
	var clientID *string
	var expires *int64
	err := h.Pool.QueryRow(r.Context(), `
		SELECT c.envelope_version, c.client_id, c.key_id, c.nonce, c.ciphertext,
		       c.wrapped_dek, c.dek_nonce, c.key_fingerprint, c.key_expires_at_ms
		  FROM store_seller_credentials c
		  JOIN organization_stores s ON s.id = c.store_id
		 WHERE c.org_id = $1 AND s.uuid = $2::uuid`, org, storeID).Scan(
		&env.Version, &clientID, &env.KeyID, &env.Nonce, &env.Ciphertext,
		&env.WrappedDEK, &env.DEKNonce, &env.Fingerprint, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", &credFail{http.StatusBadRequest, "该店铺尚未登记 Seller 密钥", "validation"}
	}
	if err != nil {
		slog.Error("catalog credential", "err", err)
		return "", "", &credFail{http.StatusInternalServerError, access.MsgUnavailable, "internal"}
	}
	if expires != nil && *expires <= h.Now().UnixMilli() {
		return "", "", &credFail{http.StatusBadRequest, "该店铺 Seller 密钥已过期，请在店铺设置重新登记", "validation"}
	}
	if clientID != nil {
		env.ClientID = *clientID
	}
	secret, err := h.Seals.OpenStore(env)
	if err != nil || secret.ClientID == "" || secret.APIKey == "" {
		return "", "", &credFail{http.StatusBadRequest, "该店铺的 Seller 密钥无效", "validation"}
	}
	return secret.ClientID, secret.APIKey, nil
}

func (h Host) fillSchema(w http.ResponseWriter, r *http.Request, category, typeID int64, language string) {
	key := strconv.FormatInt(category, 10) + "/" + strconv.FormatInt(typeID, 10) + "/" + language
	if negativeRecent(key, h.Now()) {
		writeErr(w, http.StatusBadGateway, "该类目刚刚读取失败，请一分钟后重试", "internal")
		return
	}
	listed, err := h.treeHasCoordinate(r, language, category, typeID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	if listed != nil && !*listed {
		writeErr(w, http.StatusNotFound, "类目不存在", "not_found")
		return
	}
	release, ok := claimToken("schema:" + key)
	if !ok {
		w.Header().Set("Retry-After", "3")
		writeErr(w, http.StatusServiceUnavailable, "类目数据正在读取，请稍后重试", "internal")
		return
	}
	defer release()
	keys, err := h.platformKeys(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	if len(keys) == 0 {
		jsonwire.Write(w, http.StatusOK, struct {
			Data *struct{} `json:"data"`
		}{})
		return
	}
	var last error
	for _, cred := range keys {
		fields, err := h.schemaFromSeller(r.Context(), category, typeID, language, cred.clientID, cred.apiKey)
		if err != nil {
			slog.Warn("catalog schema key", "client", cred.clientID, "err", err)
			last = err
			continue
		}
		raw, err := marshalCatalogFields(fields)
		if err != nil {
			last = err
			continue
		}
		gz, err := gzipBytes(raw)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
			return
		}
		now := h.Now().UnixMilli()
		if _, err := h.Pool.Exec(r.Context(), `
			INSERT INTO public.ozon_catalog_schema_cache
			    (description_category_id, type_id, language, payload, fetched_at_ms, byte_size, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())
			ON CONFLICT (description_category_id, type_id, language) DO UPDATE
			SET payload = EXCLUDED.payload,
			    fetched_at_ms = EXCLUDED.fetched_at_ms,
			    byte_size = EXCLUDED.byte_size,
			    updated_at = clock_timestamp()`, category, typeID, language, gz, now, len(gz)); err != nil {
			slog.Error("catalog schema cache", "err", err)
		}
		h.writeSchemaMaterial(w, r, category, typeID, language, now, raw)
		return
	}
	negativeRecord(key, h.Now())
	_ = last
	writeErr(w, http.StatusBadGateway, "平台类目读取失败，请检查平台类目密钥后重试", "internal")
}

type platformKey struct {
	clientID, apiKey string
}

func (h Host) platformKeys(ctx context.Context) ([]platformKey, error) {
	rows, err := h.Pool.Query(ctx, `
		SELECT client_id, COALESCE(api_key_key_id, ''), api_key_nonce, api_key_ciphertext
		FROM public.platform_catalog_fetch_keys
		WHERE disabled_at_ms IS NULL AND api_key_nonce IS NOT NULL AND api_key_ciphertext IS NOT NULL
		ORDER BY position`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []platformKey
	for rows.Next() {
		var clientID, keyID string
		var nonce, ct []byte
		if err := rows.Scan(&clientID, &keyID, &nonce, &ct); err != nil {
			return nil, err
		}
		plain, err := seal.OpenBlob(h.Seals.Primary, keyID, nonce, ct)
		if err != nil && len(h.Seals.Previous) == 32 {
			plain, err = seal.OpenBlob(h.Seals.Previous, keyID, nonce, ct)
		}
		if err != nil || len(plain) == 0 {
			slog.Warn("catalog platform key", "client", clientID, "err", err)
			out = append(out, platformKey{})
			continue
		}
		out = append(out, platformKey{clientID: clientID, apiKey: string(plain)})
	}
	return out, rows.Err()
}

func (h Host) schemaFromSeller(ctx context.Context, category, typeID int64, language, clientID, apiKey string) ([]domain.ListingField, error) {
	if clientID == "" || apiKey == "" {
		return nil, errors.New("platform key")
	}
	req := struct {
		Category int64   `json:"description_category_id"`
		Language *string `json:"language,omitempty"`
		TypeID   int64   `json:"type_id"`
	}{Category: category, TypeID: typeID}
	if lang := ozonLanguage(language); lang != "" {
		req.Language = &lang
	}
	body, _ := json.Marshal(req)
	status, resp, err := h.post(ctx, "/v1/description-category/attribute", body, clientID, apiKey)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, errors.New("attribute status")
	}
	attrs, err := decodeAttributes(resp)
	if err != nil {
		return nil, err
	}
	fields := domain.LiveFixedFields()
	extra := make([]domain.ListingField, len(attrs))
	sem := make(chan struct{}, 6)
	var mu sync.Mutex
	var first error
	var wg sync.WaitGroup
	for i, attr := range attrs {
		wg.Add(1)
		go func(i int, attr ozonAttribute) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			field, err := h.attributeField(ctx, category, typeID, language, clientID, apiKey, attr)
			mu.Lock()
			defer mu.Unlock()
			if err != nil && first == nil {
				first = err
				return
			}
			extra[i] = field
		}(i, attr)
	}
	wg.Wait()
	if first != nil {
		return nil, first
	}
	return append(fields, extra...), nil
}

func (h Host) attributeField(ctx context.Context, category, typeID int64, language, clientID, apiKey string, attr ozonAttribute) (domain.ListingField, error) {
	var options []domain.FieldOption
	truncated := false
	if attr.DictionaryID > 0 {
		var err error
		options, truncated, err = h.fetchValues(ctx, category, typeID, language, clientID, apiKey, attr.ID)
		if err != nil {
			return domain.ListingField{}, err
		}
	}
	group := attr.GroupName
	if group == "" {
		group = "属性"
	}
	var max *uint32
	if attr.MaxValueCount > 0 {
		n := uint32(attr.MaxValueCount)
		max = &n
	}
	var dict *string
	if attr.DictionaryID > 0 {
		text := strconv.FormatInt(attr.DictionaryID, 10)
		dict = &text
	}
	attrID := strconv.FormatInt(attr.ID, 10)
	var complexID *string
	if attr.ComplexID != 0 {
		text := strconv.FormatInt(attr.ComplexID, 10)
		complexID = &text
	}
	var rawType *string
	if attr.Type != "" {
		text := attr.Type
		rawType = &text
	}
	aspect := attr.IsAspect
	ids := make([]string, len(options))
	for i, opt := range options {
		ids[i] = opt.ID
	}
	return domain.ListingField{
		Key: "attribute_" + attrID, Label: attr.Name, Group: group,
		Editor:   domain.InferEditor(attr.Type, attr.IsCollection, attr.DictionaryID > 0, truncated),
		Required: attr.IsRequired, Collection: attr.IsCollection, MaxValueCount: max, DictionaryID: dict,
		AttributeID: &attrID, ComplexID: complexID, Description: attr.Description, RawType: rawType,
		ComplexGroupCollection: attr.ComplexCollection, Options: options, OptionsTruncated: truncated,
		Aspect: &aspect, OptionIDs: ids,
	}, nil
}

func (h Host) fetchValues(ctx context.Context, category, typeID int64, language, clientID, apiKey string, attributeID int64) ([]domain.FieldOption, bool, error) {
	var options []domain.FieldOption
	var last *int64
	seen := map[int64]struct{}{}
	for {
		req := valuesRequest{AttributeID: attributeID, Category: category, Limit: 2000, TypeID: typeID, Last: last}
		if lang := ozonLanguage(language); lang != "" {
			req.Language = &lang
		}
		body, _ := json.Marshal(req)
		status, resp, err := h.post(ctx, "/v1/description-category/attribute/values", body, clientID, apiKey)
		if err != nil {
			return nil, false, err
		}
		if status < 200 || status >= 300 {
			return nil, false, errors.New("values status")
		}
		var page struct {
			Result []struct {
				ID      int64  `json:"id"`
				Value   string `json:"value"`
				Info    string `json:"info"`
				Picture string `json:"picture"`
			} `json:"result"`
			HasNext bool `json:"has_next"`
		}
		if json.Unmarshal(resp, &page) != nil {
			return nil, false, errors.New("values json")
		}
		var lastID int64
		for _, value := range page.Result {
			if len(options) < 200 {
				options = append(options, domain.FieldOption{ID: strconv.FormatInt(value.ID, 10), Value: value.Value, Info: value.Info, Picture: value.Picture})
			} else {
				return options, true, nil
			}
			lastID = value.ID
		}
		if !page.HasNext {
			break
		}
		if lastID == 0 {
			return options, true, nil
		}
		if _, ok := seen[lastID]; ok {
			return options, true, nil
		}
		seen[lastID] = struct{}{}
		next := lastID
		last = &next
	}
	return options, false, nil
}

type valuesRequest struct {
	AttributeID int64   `json:"attribute_id"`
	Category    int64   `json:"description_category_id"`
	Language    *string `json:"language,omitempty"`
	Last        *int64  `json:"last_value_id,omitempty"`
	Limit       int64   `json:"limit"`
	TypeID      int64   `json:"type_id"`
}

type ozonAttribute struct {
	ID                int64  `json:"id"`
	ComplexID         int64  `json:"attribute_complex_id"`
	Name              string `json:"name"`
	Description       string `json:"description"`
	Type              string `json:"type"`
	IsCollection      bool   `json:"is_collection"`
	IsRequired        bool   `json:"is_required"`
	IsAspect          bool   `json:"is_aspect"`
	MaxValueCount     int64  `json:"max_value_count"`
	GroupName         string `json:"group_name"`
	DictionaryID      int64  `json:"dictionary_id"`
	ComplexCollection bool   `json:"complex_is_collection"`
}

func decodeAttributes(raw []byte) ([]ozonAttribute, error) {
	var body struct {
		Result []ozonAttribute `json:"result"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	if body.Result == nil {
		return []ozonAttribute{}, nil
	}
	return body.Result, nil
}

func (h Host) treeHasCoordinate(r *http.Request, language string, category, typeID int64) (*bool, error) {
	var payload []byte
	err := h.Pool.QueryRow(r.Context(), `SELECT payload FROM public.ozon_catalog_tree_cache WHERE language = $1`, language).Scan(&payload)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	nodes, err := domain.DecodeTree(payload)
	if err != nil {
		return nil, err
	}
	if len(nodes) == 0 {
		return nil, nil
	}
	found := walkTree(nodes, category, typeID)
	return &found, nil
}

// walkTree answers whether the flat node list carries the category/type
// pair. A node's category context is its own description_category_id when
// set, else its parent's context, exactly as the recursive walk computed.
func walkTree(nodes []domain.TreeNode, category, typeID int64) bool {
	byType := make(map[int64]*domain.TreeNode, len(nodes))
	contexts := make(map[int64]int64, len(nodes))
	var contextOf func(node *domain.TreeNode) int64
	contextOf = func(node *domain.TreeNode) int64 {
		if cached, ok := contexts[node.TypeID]; ok {
			return cached
		}
		current := node.DescriptionCategoryID
		if current <= 0 && node.ParentID != nil {
			if parent, ok := byType[*node.ParentID]; ok {
				current = contextOf(parent)
			}
		}
		contexts[node.TypeID] = current
		return current
	}
	for i := range nodes {
		byType[nodes[i].TypeID] = &nodes[i]
	}
	for i := range nodes {
		node := &nodes[i]
		if node.TypeID != typeID {
			continue
		}
		current := node.DescriptionCategoryID
		if current <= 0 {
			current = contextOf(node)
		}
		if current == category {
			return true
		}
	}
	return false
}

func (h Host) writeSchemaMaterial(w http.ResponseWriter, r *http.Request, category, typeID int64, language string, fetched int64, fields json.RawMessage) {
	parsed, err := domain.FieldsFromCache(fields)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "类目字段缓存损坏，请稍后重试", "internal")
		return
	}
	search, err := h.searchMaterials(r, category, typeID, language, parsed)
	if err != nil {
		slog.Error("catalog search material", "err", err)
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	native := domain.MaterialFromFields(category, typeID, parsed, search)
	jsonwire.Write(w, http.StatusOK, schemaWire{
		DescriptionCategoryID: category, TypeID: typeID, Language: language, FetchedAtMs: fetched,
		Fields: fields, Native: native,
	})
}

func (h Host) searchMaterials(r *http.Request, category, typeID int64, language string, fields []domain.ListingField) ([]domain.SearchHit, error) {
	truncated := false
	for _, field := range fields {
		if field.OptionsTruncated {
			truncated = true
			break
		}
	}
	if !truncated {
		return []domain.SearchHit{}, nil
	}
	rows, err := h.Pool.Query(r.Context(), `
		SELECT attribute_id, dictionary_id, option_id, value
		FROM public.catalog_dictionary_search_material
		WHERE description_category_id = $1 AND type_id = $2 AND language = $3`, category, typeID, language)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.SearchHit
	for rows.Next() {
		var hit domain.SearchHit
		if err := rows.Scan(&hit.AttributeID, &hit.DictionaryID, &hit.ValueID, &hit.Label); err != nil {
			return nil, err
		}
		hit.DescriptionCategoryID = category
		out = append(out, hit)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, field := range fields {
		if !field.OptionsTruncated || field.AttributeID == nil || *field.AttributeID != domain.NoBrandAttribute || field.DictionaryID == nil {
			continue
		}
		dict, err := strconv.ParseInt(*field.DictionaryID, 10, 64)
		if err != nil {
			continue
		}
		out = append(out, domain.SearchHit{
			DescriptionCategoryID: category, AttributeID: 85, DictionaryID: dict,
			ValueID: domain.NoBrandValueID, Label: domain.NoBrandLabel,
		})
	}
	if out == nil {
		out = []domain.SearchHit{}
	}
	return out, nil
}

type schemaWire struct {
	DescriptionCategoryID int64                   `json:"description_category_id"`
	TypeID                int64                   `json:"type_id"`
	Language              string                  `json:"language"`
	FetchedAtMs           int64                   `json:"fetched_at_ms"`
	Fields                json.RawMessage         `json:"fields"`
	Native                domain.SnapshotMaterial `json:"native_material"`
}

func (h Host) post(ctx context.Context, path string, body []byte, clientID, apiKey string) (int, []byte, error) {
	if h.Seller == nil {
		return 0, nil, errUnreachable
	}
	return h.Seller(ctx, path, body, clientID, apiKey)
}

var errUnreachable = errors.New("unreachable")

type sellerClass interface{ SellerClass() string }

func writeSellerErr(w http.ResponseWriter, err error, platform bool) {
	class := "unreachable"
	var marked sellerClass
	if errors.As(err, &marked) {
		class = marked.SellerClass()
	}
	switch class {
	case "saturated":
		writeErr(w, http.StatusTooManyRequests, "该店铺的 Seller 请求过于密集，请稍后重试", "internal")
	case "credential":
		msg := "该店铺的 Seller 密钥无效"
		if platform {
			msg = "平台 Seller 密钥无效：请检查 Client-Id 与 Api-Key"
		}
		writeErr(w, http.StatusBadRequest, msg, "validation")
	default:
		writeErr(w, http.StatusBadGateway, "Seller 服务暂时无法访问", "internal")
	}
}

func ozonLanguage(language string) string {
	switch language {
	case "ru":
		return "RU"
	case "en":
		return "EN"
	case "tr":
		return "TR"
	case "zh_hans":
		return "ZH_HANS"
	default:
		return ""
	}
}

func gzipBytes(raw []byte) ([]byte, error) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(raw); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func cacheNodes(raw []byte) ([]domain.StorageNode, error) {
	var body struct {
		Result []ozonNode `json:"result"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	return mapNodes(body.Result), nil
}

type ozonNode struct {
	DescriptionCategoryID int64      `json:"description_category_id"`
	CategoryName          string     `json:"category_name"`
	TypeID                int64      `json:"type_id"`
	TypeName              string     `json:"type_name"`
	Disabled              bool       `json:"disabled"`
	Children              []ozonNode `json:"children"`
}

func mapNodes(in []ozonNode) []domain.StorageNode {
	if len(in) == 0 {
		return []domain.StorageNode{}
	}
	out := make([]domain.StorageNode, len(in))
	for i, node := range in {
		children := mapNodes(node.Children)
		if len(children) == 0 {
			children = nil
		}
		out[i] = domain.StorageNode{
			DescriptionCategoryID: node.DescriptionCategoryID, CategoryName: node.CategoryName,
			TypeID: node.TypeID, TypeName: node.TypeName, Disabled: node.Disabled, Children: children,
		}
	}
	return out
}

func marshalCatalogFields(fields []domain.ListingField) (json.RawMessage, error) {
	out := make([]catalogField, len(fields))
	for i, field := range fields {
		item := catalogField{
			Key: field.Key, Label: field.Label, Group: field.Group, Editor: field.Editor,
			Required: field.Required, Collection: field.Collection, Max: field.MaxValueCount,
			Dictionary: field.DictionaryID, Attribute: field.AttributeID, Complex: field.ComplexID,
			Description: field.Description, RawType: field.RawType, ReadOnly: field.ReadOnly,
			ComplexGroup: field.ComplexGroupCollection, Truncated: field.OptionsTruncated, Aspect: field.Aspect,
		}
		if len(field.Options) > 0 {
			item.Options = field.Options
		}
		out[i] = item
	}
	return json.Marshal(out)
}

type catalogField struct {
	Key          string               `json:"key"`
	Label        string               `json:"label"`
	Group        string               `json:"group"`
	Editor       string               `json:"editor"`
	Required     bool                 `json:"required"`
	Collection   bool                 `json:"collection"`
	Max          *uint32              `json:"max_value_count,omitempty"`
	Dictionary   *string              `json:"dictionary_id,omitempty"`
	Attribute    *string              `json:"attribute_id,omitempty"`
	Complex      *string              `json:"complex_id,omitempty"`
	Description  string               `json:"description,omitempty"`
	RawType      *string              `json:"raw_type,omitempty"`
	ReadOnly     bool                 `json:"read_only,omitempty"`
	ComplexGroup bool                 `json:"complex_group_collection,omitempty"`
	Options      []domain.FieldOption `json:"options,omitempty"`
	Truncated    bool                 `json:"options_truncated,omitempty"`
	Aspect       *bool                `json:"aspect,omitempty"`
}
