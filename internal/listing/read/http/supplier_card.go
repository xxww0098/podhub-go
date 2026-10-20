package readhttp

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

func (h Host) insertSupplier(w http.ResponseWriter, r *http.Request, user, org int64, title string, store *string, product string) {
	storeID := ""
	if store != nil && strings.TrimSpace(*store) != "" {
		bound, ok := h.visibleStore(w, r, org, user, store)
		if !ok {
			return
		}
		storeID = bound
	}
	var item cardRow
	err := h.withOrg(r.Context(), org, func(tx pgx.Tx) error {
		facts, err := loadSupplier(r, tx, product, h.clock().UnixMilli())
		if err != nil {
			return err
		}
		if facts.missingProduct {
			return rowRefuse{http.StatusNotFound, "供应商商品不存在或当前不可上架", "not_found"}
		}
		if facts.missingConfig {
			return rowRefuse{http.StatusNotFound, "供应商商品或 Ozon 配置不存在", "not_found"}
		}
		if facts.denial != "" {
			return supplierRefusal{facts.denial}
		}
		payload, err := supplierPayload(facts, product)
		if err != nil {
			return err
		}
		cardTitle := strings.TrimSpace(title)
		if cardTitle == "" {
			cardTitle = facts.title
		}
		id := uuid.NewString()
		row := tx.QueryRow(r.Context(), `
			INSERT INTO listing_cards (
			    id, org_id, title, store_id, payload, created_by, updated_by
			) VALUES (
			    $1::uuid, $2, $3, NULLIF($4, '')::uuid, $5::jsonb, $6, $6
			)
			ON CONFLICT (org_id, supplier_product_id)
			    WHERE supplier_product_id IS NOT NULL
			DO UPDATE SET id = listing_cards.id
			RETURNING `+cardSelect, id, org, cardTitle, storeID, payload, user)
		scanned, err := scanCard(row)
		if err != nil {
			return err
		}
		item = scanned
		return nil
	})
	var refuse rowRefuse
	if errors.As(err, &refuse) {
		writeErr(w, refuse.status, refuse.message, refuse.code)
		return
	}
	var denied supplierRefusal
	if errors.As(err, &denied) {
		jsonwire.Write(w, http.StatusConflict, struct {
			Error  string `json:"error"`
			Code   string `json:"code"`
			Denial string `json:"denial"`
		}{Error: denied.code, Code: "supplier_not_listable", Denial: denied.code})
		return
	}
	if err != nil {
		writeDB(w, err)
		return
	}
	writeCard(w, item)
}

type supplierRefusal struct{ code string }

func (s supplierRefusal) Error() string { return s.code }

type supplierFacts struct {
	missingProduct bool
	missingConfig  bool
	denial         string
	title          string
	size           string
	promptFile     string
	category       int64
	typeID         int64
	language       string
}

func loadSupplier(r *http.Request, tx pgx.Tx, product string, now int64) (supplierFacts, error) {
	var facts supplierFacts
	var (
		title, size, promptFile, promptText string
		archived, published                 bool
		sourceListed, skuPublished          *bool
		state, validated, current           *string
		category, typeID                    *int64
		language                            *string
		fetched                             *int64
	)
	err := tx.QueryRow(r.Context(), `
		SELECT p.title, p.size, p.prompt_file_name, p.archived, p.published,
		       src.listed, s.published,
		       c.state, c.validated_catalog_digest, c.description_category_id, c.type_id, c.language, c.prompt_text,
		       cat.content_digest, cat.fetched_at_ms
		FROM sc_products p
		LEFT JOIN sc_sources src ON src.source_id = p.source_id
		LEFT JOIN LATERAL (
		    SELECT published FROM sc_skus WHERE product_id = p.product_id ORDER BY sku_id LIMIT 1
		) s ON TRUE
		LEFT JOIN supplier_ozon_configs c ON c.product_id = p.product_id
		LEFT JOIN ozon_category_current cat
		       ON cat.description_category_id = c.description_category_id
		      AND cat.type_id = c.type_id AND cat.language = c.language
		WHERE p.product_id = $1
		LIMIT 1`, product).Scan(
		&title, &size, &promptFile, &archived, &published,
		&sourceListed, &skuPublished,
		&state, &validated, &category, &typeID, &language, &promptText,
		&current, &fetched,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		facts.missingProduct = true
		return facts, nil
	}
	if err != nil {
		return facts, err
	}
	if category == nil || typeID == nil || language == nil {
		facts.missingConfig = true
		return facts, nil
	}
	facts.title = title
	facts.size = size
	facts.promptFile = promptFile
	facts.category = *category
	facts.typeID = *typeID
	facts.language = *language
	fresh := "fresh"
	if fetched != nil {
		age := now - *fetched
		if *fetched > now {
			age = 0
		}
		if age > 72*time.Hour.Milliseconds() {
			fresh = "expired"
		}
	}
	listed := sourceListed != nil && *sourceListed
	sku := skuPublished != nil && *skuPublished
	config := "needs_reconfiguration"
	if state != nil && *state == "valid" {
		config = "valid"
	}
	promptValid := strings.TrimSpace(promptText) != ""
	switch {
	case !listed:
		facts.denial = "source_not_listed"
	case archived:
		facts.denial = "product_archived"
	case !published || !sku:
		facts.denial = "sku_not_published"
	case fresh == "expired":
		facts.denial = "catalog_expired"
	case current == nil:
		facts.denial = "catalog_missing"
	case config != "valid":
		facts.denial = "config_needs_reconfiguration"
	case validated == nil || current == nil || *validated != *current:
		facts.denial = "catalog_digest_mismatch"
	case !promptValid:
		facts.denial = "prompt_invalid"
	}
	return facts, nil
}

func supplierPayload(facts supplierFacts, product string) ([]byte, error) {
	raw, err := json.Marshal(map[string]any{
		"categoryKey":           "workflow:" + strconv.FormatInt(facts.category, 10) + ":" + strconv.FormatInt(facts.typeID, 10),
		"descriptionCategoryId": facts.category,
		"typeId":                facts.typeID,
		"language":              facts.language,
		"defaults":              json.RawMessage(`{"values":{},"complex_values":[]}`),
		"supplierProductId":     product,
		"aiFieldPolicy":         json.RawMessage(`{"allowed_field_keys":[],"protected_field_keys":[]}`),
		"size":                  emptyOmit(facts.size),
		"aiPromptFileName":      emptyOmit(facts.promptFile),
	})
	if err != nil {
		return nil, err
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	if facts.size == "" {
		delete(body, "size")
	}
	if facts.promptFile == "" {
		delete(body, "aiPromptFileName")
	}
	cleaned, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return PrepareCard(cleaned, nil)
}

func emptyOmit(s string) string { return s }
