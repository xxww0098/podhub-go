package x1repo

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	contract "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	x1contract "github.com/xxww0098/podhub-go/internal/admin/x1/contract"
)

func rawOr(b []byte, fallback string) []byte {
	if len(b) == 0 {
		return []byte(fallback)
	}
	return b
}

func rowConstraint(err error) error {
	switch corerepo.Constraint(err) {
	case "":
		return corerepo.MapDB(err)
	case "ux_sc_skus_platform_code":
		return corerepo.Conflict("平台货号已被占用")
	case "ux_sc_products_variant_group_size":
		return corerepo.Conflict("同款尺寸已存在")
	default:
		return corerepo.Conflict("记录冲突")
	}
}

func rowMissing(ctx context.Context, tx pgx.Tx, sourceID, productID string) error {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM public.sc_products WHERE product_id=$1 AND source_id=$2)`, productID, sourceID).Scan(&exists); err != nil {
		return corerepo.MapDB(err)
	}
	if exists {
		return corerepo.Conflict("商品已被其他操作更新")
	}
	return corerepo.NotFound(corerepo.MissingRow)
}

func insertProduct(ctx context.Context, tx pgx.Tx, in x1contract.RowInput, productID, sourceID, publicID string, now int64) error {
	if strings.TrimSpace(in.VariantGroup) != "" && strings.TrimSpace(in.Size) == "" {
		return &contract.Fail{Kind: contract.KindValidation, Message: "同款分组需要填写尺寸"}
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO public.sc_products
		    (product_id, source_id, title, variant_group, description, published, revision,
		     prompt_name, prompt_file_name, product_videos, gallery, psd,
		     description_category_id, type_id, internal_note, props, archived,
		     size, material, craft, gross_weight_g,
		     brand, pack_width_mm, pack_height_mm, pack_depth_mm, pack_weight_g,
		     contents, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ($1, $2, $3, $20, $4, false, 1, $5, $6,
		        $7, $8, $9, $10, $11, $12, $13, false, $16, $18, $19, $17,
		        $21, $22, $23, $24, $25, $26, $14, $14, $15)`,
		productID, sourceID, in.Title, in.Description, in.PromptName, in.PromptFileName,
		rawOr(in.Videos, `[]`), rawOr(in.Gallery, `[]`), rawOr(in.PSD, `[]`),
		in.DescriptionCategoryID, in.TypeID, in.InternalNote, rawOr(in.Props, `{}`), now, publicID,
		in.Size, in.GrossWeightG, in.Material, in.Craft, in.VariantGroup, in.Brand,
		in.PackWidthMM, in.PackHeightMM, in.PackDepthMM, in.PackWeightG, in.Contents)
	return rowConstraint(err)
}

func insertSKU(ctx context.Context, tx pgx.Tx, skuID, productID, code, title string, in x1contract.RowInput, publicID string, now int64) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO public.sc_skus
		    (sku_id, product_id, platform_code, title, lead_time,
		     published, revision, suggested_retail_cents,
		     suggested_old_price_cents, created_at_ms, updated_at_ms,
		     created_by_account_uuid)
		VALUES ($1, $2, $3, $4, $5, false, 1, $6, $7, $8, $8, $9)`,
		skuID, productID, code, title, in.LeadTime, in.SuggestedRetail, in.SuggestedOld, now, publicID)
	return rowConstraint(err)
}

func upsertOffer(ctx context.Context, tx pgx.Tx, sourceID, skuID string, cost, shipping *int64, now int64) error {
	if cost == nil && shipping == nil {
		_, err := tx.Exec(ctx, `DELETE FROM public.sc_source_offers WHERE source_id=$1 AND sku_id=$2`, sourceID, skuID)
		return corerepo.MapDB(err)
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO public.sc_source_offers
		    (source_id, sku_id, cost_cents, shipping_cost_cents, created_at_ms, updated_at_ms)
		VALUES ($1, $2, $3, $4, $5, $5)
		ON CONFLICT (source_id, sku_id)
		DO UPDATE SET cost_cents = $3, shipping_cost_cents = $4, updated_at_ms = $5`,
		sourceID, skuID, cost, shipping, now)
	return corerepo.MapDB(err)
}

func listProps(ctx context.Context, tx pgx.Tx, sourceID string) ([]x1contract.Prop, error) {
	rows, err := tx.Query(ctx, `
		SELECT prop_id, source_id, name, type, options, position, seller_visible, created_at_ms, updated_at_ms
		  FROM public.sc_source_prop_defs WHERE source_id = $1 ORDER BY position, prop_id`, sourceID)
	if err != nil {
		return nil, corerepo.MapDB(err)
	}
	defer rows.Close()
	out := []x1contract.Prop{}
	for rows.Next() {
		var prop x1contract.Prop
		var options []byte
		if err := rows.Scan(&prop.PropID, &prop.SourceID, &prop.Name, &prop.Type, &options, &prop.Position, &prop.SellerVisible, &prop.CreatedAtMs, &prop.UpdatedAtMs); err != nil {
			return nil, corerepo.MapDB(err)
		}
		if len(options) == 0 {
			options = []byte(`[]`)
		}
		prop.Options = options
		out = append(out, prop)
	}
	return out, corerepo.MapDB(rows.Err())
}

func loadRows(ctx context.Context, tx pgx.Tx, sourceID string, now int64) ([]x1contract.RowData, error) {
	rows, err := tx.Query(ctx, rowSelect+`
		WHERE p.source_id = $1 AND NOT p.archived
		  AND (SELECT COUNT(*) FROM public.sc_skus k WHERE k.product_id = p.product_id) = 1
		ORDER BY p.created_at_ms, p.product_id`, sourceID)
	if err != nil {
		return nil, corerepo.MapDB(err)
	}
	defer rows.Close()
	out := []x1contract.RowData{}
	for rows.Next() {
		row, err := scanRow(rows, now)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, corerepo.MapDB(rows.Err())
}

func loadRow(ctx context.Context, tx pgx.Tx, sourceID, productID string, now int64) (x1contract.RowData, error) {
	rows, err := tx.Query(ctx, rowSelect+`
		WHERE p.source_id = $1 AND p.product_id = $2
		  AND (SELECT COUNT(*) FROM public.sc_skus k WHERE k.product_id = p.product_id) = 1`, sourceID, productID)
	if err != nil {
		return x1contract.RowData{}, corerepo.MapDB(err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return x1contract.RowData{}, corerepo.MapDB(err)
		}
		return x1contract.RowData{}, corerepo.NotFound(corerepo.MissingRow)
	}
	return scanRow(rows, now)
}

type rower interface {
	Scan(dest ...any) error
}

func scanRow(rows rower, now int64) (x1contract.RowData, error) {
	var row x1contract.RowData
	var description string
	var productPub, skuPub, listed bool
	var promptTags, publishedTags, videos, gallery, psd, props []byte
	var publishedPrompt string
	var draft, publishedRev *int32
	var state, validated, current *string
	var fetched *int64
	var creator *string
	var skuUpdatedSkip int64
	facts := x1contract.RowFacts{NowMS: now}
	if err := rows.Scan(
		&row.ProductID, &row.SourceID, &row.Title, &description, &row.VariantGroup,
		&productPub, &row.Revision, &row.PromptName, &row.PromptFileName,
		&row.PromptContent, &promptTags, &publishedPrompt, &publishedTags,
		&draft, &publishedRev, &videos, &gallery, &psd,
		&state, &validated, &current, &fetched, &listed,
		&row.DescriptionCategoryID, &row.TypeID, &row.InternalNote, &props, &row.Archived,
		&row.Size, &row.Material, &row.Craft, &row.GrossWeightG, &row.Brand,
		&row.PackWidthMM, &row.PackHeightMM, &row.PackDepthMM, &row.PackWeightG, &row.Contents,
		&row.CreatedAtMS, &row.UpdatedAtMS, &row.CreatedBy, &creator,
		&row.SKU, &row.PlatformCode, &row.LeadTime, &skuPub,
		&row.SuggestedRetailCents, &row.SuggestedOldPrice,
		&row.CostCents, &row.ShippingCostCents, &row.PlatformPriceCents,
	); err != nil {
		return x1contract.RowData{}, corerepo.MapDB(err)
	}
	_ = skuUpdatedSkip
	row.Description = description
	row.Published = productPub && skuPub
	row.Gallery = itemsGallery(gallery)
	row.PSD = itemsFiles(psd)
	row.ProductVideos = itemsVideos(videos)
	row.FixedTags = tagsOf(promptTags)
	row.Props = propsOf(props)
	row.DraftPromptRevision = draft
	row.PublishedPromptRev = publishedRev
	row.CreatorName = creator
	facts.SourceListed = listed
	facts.Archived = row.Archived
	facts.SKUPublished = skuPub
	facts.CategoryID = row.DescriptionCategoryID
	facts.TypeID = row.TypeID
	facts.PublishedPrompt = publishedPrompt
	facts.PublishedTags = tagsOf(publishedTags)
	facts.PlatformPrice = row.PlatformPriceCents
	facts.ConfigState = state
	facts.ValidatedDigest = validated
	facts.CurrentDigest = current
	facts.CatalogFetchedAt = fetched
	row.FillReadiness(facts)
	row.EmptyRowSlices()
	return row, nil
}

func tagsOf(raw []byte) []string {
	var out []string
	if json.Unmarshal(raw, &out) != nil || out == nil {
		return []string{}
	}
	return out
}

func propsOf(raw []byte) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	if len(raw) == 0 || json.Unmarshal(raw, &out) != nil || out == nil {
		return map[string]json.RawMessage{}
	}
	return out
}

func itemsGallery(raw []byte) []x1contract.GalleryItem {
	var out []x1contract.GalleryItem
	if json.Unmarshal(raw, &out) != nil || out == nil {
		return []x1contract.GalleryItem{}
	}
	return out
}

func itemsFiles(raw []byte) []x1contract.FileItem {
	var out []x1contract.FileItem
	if json.Unmarshal(raw, &out) != nil || out == nil {
		return []x1contract.FileItem{}
	}
	return out
}

func itemsVideos(raw []byte) []x1contract.VideoItem {
	var out []x1contract.VideoItem
	if json.Unmarshal(raw, &out) != nil || out == nil {
		return []x1contract.VideoItem{}
	}
	return out
}

func jsonBytes(v any) []byte {
	return []byte(x1contract.JSONText(v))
}

type editor struct {
	exists     bool
	category   int64
	typeID     int64
	language   string
	values     []byte
	tags       []byte
	prompt     string
	ai         []byte
	revision   int64
	state      string
	digest     *string
	issues     []byte
	published  *int32
	updated    int64
	compareTxt string
	compareTag []byte
	compareAI  []byte
	stamp      x1contract.CatalogStamp
	newCoords  bool
}

func loadEditor(ctx context.Context, tx pgx.Tx, productID string) (editor, error) {
	var e editor
	var category, typeID *int64
	err := tx.QueryRow(ctx, `
		SELECT description_category_id, type_id FROM public.sc_products WHERE product_id = $1`, productID).Scan(&category, &typeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return editor{}, corerepo.NotFound(corerepo.MissingRow)
	}
	if err != nil {
		return editor{}, corerepo.MapDB(err)
	}
	err = tx.QueryRow(ctx, `
		SELECT description_category_id, type_id, language, values, fixed_tags, prompt_text, ai_output,
		       revision, state, validated_catalog_digest, issues, published_revision, updated_at_ms
		  FROM public.supplier_ozon_configs WHERE product_id = $1`, productID).Scan(
		&e.category, &e.typeID, &e.language, &e.values, &e.tags, &e.prompt, &e.ai,
		&e.revision, &e.state, &e.digest, &e.issues, &e.published, &e.updated)
	if errors.Is(err, pgx.ErrNoRows) {
		e.language = "zh_hans"
		e.values = []byte(`{}`)
		e.tags = []byte(`[]`)
		e.ai = jsonBytes(x1contract.DefaultAI())
		e.issues = []byte(`[]`)
	} else if err != nil {
		return editor{}, corerepo.MapDB(err)
	} else {
		e.exists = true
	}
	var brief *string
	var revTags, revAI []byte
	err = tx.QueryRow(ctx, `
		SELECT brief, fixed_tags, ai_output FROM public.prompt_revisions
		 WHERE product_id = $1 ORDER BY revision DESC LIMIT 1`, productID).Scan(&brief, &revTags, &revAI)
	if err == nil {
		e.compareTxt = *brief
		e.compareTag = revTags
		e.compareAI = revAI
	} else if errors.Is(err, pgx.ErrNoRows) {
		e.compareTxt = e.prompt
		e.compareTag = e.tags
		e.compareAI = e.ai
	} else {
		return editor{}, corerepo.MapDB(err)
	}
	if category != nil && typeID != nil && *category > 0 && *typeID > 0 {
		lang := e.language
		if lang == "" {
			lang = "zh_hans"
		}
		var digest string
		var fetched int64
		err = tx.QueryRow(ctx, `
			SELECT content_digest, fetched_at_ms FROM public.ozon_category_current
			 WHERE description_category_id = $1 AND type_id = $2 AND language = $3`, *category, *typeID, lang).Scan(&digest, &fetched)
		if err == nil {
			e.stamp = x1contract.CatalogStamp{Digest: digest, Fetched: fetched, Present: true}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return editor{}, corerepo.MapDB(err)
		}
	}
	if category != nil {
		e.newCoords = !e.exists || e.category != *category || e.typeID != *typeID
	} else {
		e.newCoords = true
	}
	return e, nil
}

func writeRowConfig(ctx context.Context, tx pgx.Tx, actor contract.Actor, sourceID, productID, content string, tags []string, publicID string, now int64) error {
	var category, typeID *int64
	var got string
	err := tx.QueryRow(ctx, `
		SELECT source_id, description_category_id, type_id FROM public.sc_products
		 WHERE product_id = $1 FOR NO KEY UPDATE`, productID).Scan(&got, &category, &typeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return corerepo.NotFound(corerepo.MissingRow)
	}
	if err != nil {
		return corerepo.MapDB(err)
	}
	ed, err := loadEditor(ctx, tx, productID)
	if err != nil {
		return err
	}
	coords := category != nil && typeID != nil && *category > 0 && *typeID > 0
	if !coords {
		_, err := tx.Exec(ctx, `
			UPDATE public.supplier_ozon_configs
			SET state = 'needs_reconfiguration', validated_catalog_digest = NULL, issues = $2,
			    revision = revision + 1, updated_at_ms = $3, updated_by_account_uuid = $4
			WHERE product_id = $1 AND issues <> $2`,
			productID, []byte(x1contract.LegacyIssues()), now, publicID)
		return corerepo.MapDB(err)
	}
	incomingTags := jsonBytes(tags)
	if ed.exists && ed.category == *category && ed.typeID == *typeID && ed.compareTxt == content && bytesEqual(ed.compareTag, incomingTags) && !x1contract.HasLegacyIssue(ed.issues) && digestEqual(ed.digest, ed.stamp) {
		return nil
	}
	values := []byte(`{}`)
	if ed.exists && ed.category == *category && ed.typeID == *typeID && len(ed.values) > 0 {
		values = ed.values
	}
	lang := ed.language
	if lang == "" {
		lang = "zh_hans"
	}
	expected := int64(0)
	if ed.exists {
		expected = ed.revision
	}
	judge := x1contract.Judge(valuesMap(values), ed.stamp, now)
	incomingAI := ed.compareAI
	if len(incomingAI) == 0 {
		incomingAI = jsonBytes(x1contract.DefaultAI())
	}
	if err := putOzon(ctx, tx, actor, sourceID, productID, *category, *typeID, lang, values, incomingTags, content, incomingAI, ed, judge, expected, publicID, now); err != nil {
		return err
	}
	if !ed.exists || ed.category != *category || ed.typeID != *typeID {
		_, err := tx.Exec(ctx, `
			UPDATE public.supplier_ozon_configs
			SET state = 'needs_reconfiguration', validated_catalog_digest = NULL, issues = $2
			WHERE product_id = $1`, productID, []byte(x1contract.LegacyIssues()))
		return corerepo.MapDB(err)
	}
	return nil
}

func digestEqual(stored *string, stamp x1contract.CatalogStamp) bool {
	if !stamp.Present {
		return stored == nil || *stored == ""
	}
	return stored != nil && *stored == stamp.Digest
}

func bytesEqual(a, b []byte) bool {
	return string(canonTags(a)) == string(canonTags(b))
}

func canonTags(raw []byte) []byte {
	return jsonBytes(tagsOf(raw))
}

func valuesMap(raw []byte) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	_ = json.Unmarshal(raw, &out)
	return out
}

func putOzon(ctx context.Context, tx pgx.Tx, actor contract.Actor, sourceID, productID string, category, typeID int64, language string, values, tags []byte, prompt string, incomingAI []byte, ed editor, judge x1contract.JudgeResult, expected int64, publicID string, now int64) error {
	if _, err := corerepo.LockSource(ctx, tx, sourceID); err != nil {
		return err
	}
	if _, _, err := corerepo.LockProduct(ctx, tx, sourceID, productID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		SELECT product_id FROM public.sc_products WHERE source_id = $1 AND product_id = $2 FOR NO KEY UPDATE`, sourceID, productID); err != nil {
		return corerepo.MapDB(err)
	}
	cellPrompt, cellTags, cellAI := prompt, tags, incomingAI
	if ed.published != nil {
		cellPrompt, cellTags, cellAI = ed.prompt, ed.tags, ed.ai
	}
	var wrote int64
	var err error
	if expected == 0 {
		err = tx.QueryRow(ctx, `
			INSERT INTO public.supplier_ozon_configs (
			    product_id, description_category_id, type_id, language,
			    values, fixed_tags, prompt_text, ai_output, revision, state,
			    validated_catalog_digest, issues, created_at_ms, updated_at_ms,
			    created_by_account_uuid, updated_by_account_uuid)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, $12, $12, $13, $13)
			ON CONFLICT (product_id) DO NOTHING
			RETURNING revision`,
			productID, category, typeID, language, values, cellTags, cellPrompt, cellAI, judge.State, judge.Digest, rawOr(judge.Issues, `[]`), now, publicID).Scan(&wrote)
		if errors.Is(err, pgx.ErrNoRows) {
			return corerepo.Conflict("配置已被其他操作更新")
		}
	} else {
		err = tx.QueryRow(ctx, `
			UPDATE public.supplier_ozon_configs
			SET description_category_id = $2, type_id = $3, language = $4,
			    values = $5, fixed_tags = $6, prompt_text = $7, ai_output = $8
			WHERE product_id = $1 AND revision = $9
			RETURNING revision`,
			productID, category, typeID, language, values, cellTags, cellPrompt, cellAI, expected).Scan(&wrote)
		if errors.Is(err, pgx.ErrNoRows) {
			return corerepo.Conflict("配置已被其他操作更新")
		}
		if err == nil {
			if _, err = tx.Exec(ctx, `
				UPDATE public.supplier_ozon_configs
				SET state = $2, validated_catalog_digest = $3, issues = $4,
				    revision = revision + 1, updated_at_ms = $5,
				    updated_by_account_uuid = $6, values = $7
				WHERE product_id = $1`,
				productID, judge.State, judge.Digest, rawOr(judge.Issues, `[]`), now, publicID, values); err != nil {
				return corerepo.MapDB(err)
			}
		}
	}
	if err != nil {
		return corerepo.MapDB(err)
	}
	if err := recordIntent(ctx, tx, productID, prompt, tags, incomingAI, publicID, now); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE public.sc_products SET revision = revision + 1, updated_at_ms = $3
		 WHERE source_id = $1 AND product_id = $2`, sourceID, productID, now); err != nil {
		return corerepo.MapDB(err)
	}
	return corerepo.AuditApplied(ctx, tx, actor, "supplier_dbs", "supplier_ozon_config", productID, "PUT", pathOzon, "supplier_ozon_config_saved", x1contract.JSONText(struct {
		SourceID string `json:"sourceId"`
		Category int64  `json:"descriptionCategoryId"`
		TypeID   int64  `json:"typeId"`
		Language string `json:"language"`
		State    string `json:"state"`
		Issues   int    `json:"issueCount"`
	}{sourceID, category, typeID, language, judge.State, judge.Count}))
}

func recordIntent(ctx context.Context, tx pgx.Tx, productID, brief string, tags, ai []byte, author string, now int64) error {
	var pointer *int32
	err := tx.QueryRow(ctx, `SELECT published_revision FROM public.supplier_ozon_configs WHERE product_id = $1`, productID).Scan(&pointer)
	if err != nil {
		return corerepo.MapDB(err)
	}
	if pointer == nil {
		if strings.TrimSpace(brief) == "" {
			return nil
		}
		rev, same, err := latestSnapshot(ctx, tx, productID, brief, tags, ai)
		if err != nil {
			return err
		}
		if !same {
			rev, err = insertRevision(ctx, tx, productID, brief, tags, ai, author, now)
			if err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, `
			UPDATE public.supplier_ozon_configs SET published_revision = $2
			 WHERE product_id = $1 AND published_revision IS NULL`, productID, rev)
		return corerepo.MapDB(err)
	}
	_, same, err := latestSnapshot(ctx, tx, productID, brief, tags, ai)
	if err != nil {
		return err
	}
	if same {
		return nil
	}
	_, err = insertRevision(ctx, tx, productID, brief, tags, ai, author, now)
	return err
}

func latestSnapshot(ctx context.Context, tx pgx.Tx, productID, brief string, tags, ai []byte) (int32, bool, error) {
	var rev int32
	var gotBrief string
	var gotTags, gotAI []byte
	err := tx.QueryRow(ctx, `
		SELECT revision, brief, fixed_tags, ai_output FROM public.prompt_revisions
		 WHERE product_id = $1 ORDER BY revision DESC LIMIT 1`, productID).Scan(&rev, &gotBrief, &gotTags, &gotAI)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, corerepo.MapDB(err)
	}
	return rev, gotBrief == brief && bytesEqual(gotTags, tags) && string(gotAI) == string(ai), nil
}

func insertRevision(ctx context.Context, tx pgx.Tx, productID, brief string, tags, ai []byte, author string, now int64) (int32, error) {
	var rev int32
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(revision), 0) + 1 FROM public.prompt_revisions WHERE product_id = $1`, productID).Scan(&rev); err != nil {
		return 0, corerepo.MapDB(err)
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO public.prompt_revisions
		    (product_id, revision, brief, fixed_tags, ai_output, note, author_id, created_at_ms)
		VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)`,
		productID, rev, brief, tags, ai, author, now)
	return rev, corerepo.MapDB(err)
}
