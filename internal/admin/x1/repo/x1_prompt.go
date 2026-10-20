package x1repo

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"

	contract "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	x1contract "github.com/xxww0098/podhub-go/internal/admin/x1/contract"
)

func (r X1) LoadOzon(ctx context.Context, actor contract.Actor, sourceID, productID string, now int64) (x1contract.OzonConfig, error) {
	var out x1contract.OzonConfig
	err := r.withRead(ctx, actor.OrgID, func(tx pgx.Tx) error {
		cfg, err := readOzon(ctx, tx, actor, sourceID, productID, now)
		if err != nil {
			return err
		}
		out = cfg
		return nil
	})
	return out, err
}

func (r X1) SaveOzon(ctx context.Context, actor contract.Actor, sourceID, productID string, in x1contract.OzonPut, now int64) (x1contract.OzonConfig, error) {
	var out x1contract.OzonConfig
	err := r.withWrite(ctx, actor.OrgID, func(tx pgx.Tx) error {
		publicID, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		if err := corerepo.RequireSource(ctx, tx, sourceID, owner); err != nil {
			return err
		}
		if _, err := corerepo.LockSource(ctx, tx, sourceID); err != nil {
			return err
		}
		if _, _, err := corerepo.LockProduct(ctx, tx, sourceID, productID); err != nil {
			return err
		}
		ed, err := loadEditor(ctx, tx, productID)
		if err != nil {
			return err
		}
		stamp, err := loadStamp(ctx, tx, in.Category, in.TypeID, in.Language)
		if err != nil {
			return err
		}
		judge := x1contract.Judge(in.Values, stamp, now)
		if err := putOzon(ctx, tx, actor, sourceID, productID, in.Category, in.TypeID, in.Language, in.ValuesJSON, jsonBytes(in.Tags), in.Prompt, jsonBytes(in.AI), ed, judge, in.Expected, publicID, now); err != nil {
			return err
		}
		out, err = readOzon(ctx, tx, actor, sourceID, productID, now)
		return err
	})
	return out, err
}

func loadStamp(ctx context.Context, tx pgx.Tx, category, typeID int64, language string) (x1contract.CatalogStamp, error) {
	var digest string
	var fetched int64
	err := tx.QueryRow(ctx, `
		SELECT content_digest, fetched_at_ms FROM public.ozon_category_current
		 WHERE description_category_id = $1 AND type_id = $2 AND language = $3`, category, typeID, language).Scan(&digest, &fetched)
	if errors.Is(err, pgx.ErrNoRows) {
		return x1contract.CatalogStamp{}, nil
	}
	if err != nil {
		return x1contract.CatalogStamp{}, corerepo.MapDB(err)
	}
	return x1contract.CatalogStamp{Digest: digest, Fetched: fetched, Present: true}, nil
}

func readOzon(ctx context.Context, tx pgx.Tx, actor contract.Actor, sourceID, productID string, now int64) (x1contract.OzonConfig, error) {
	_, owner, err := rIdentity(ctx, tx, actor)
	if err != nil {
		return x1contract.OzonConfig{}, err
	}
	if err := corerepo.RequireSource(ctx, tx, sourceID, owner); err != nil {
		return x1contract.OzonConfig{}, err
	}
	row, err := loadRow(ctx, tx, sourceID, productID, now)
	if err != nil {
		return x1contract.OzonConfig{}, err
	}
	var cfg x1contract.OzonConfig
	var values, issues, ai []byte
	var digest *string
	err = tx.QueryRow(ctx, `
		SELECT description_category_id, type_id, language, values, ai_output, revision, state,
		       validated_catalog_digest, issues, updated_at_ms
		  FROM public.supplier_ozon_configs WHERE product_id = $1`, productID).Scan(
		&cfg.DescriptionCategoryID, &cfg.TypeID, &cfg.Language, &values, &ai, &cfg.Revision, &cfg.State,
		&digest, &issues, &cfg.UpdatedAtMs)
	if errors.Is(err, pgx.ErrNoRows) {
		return x1contract.OzonConfig{}, corerepo.NotFound(corerepo.MissingRow)
	}
	if err != nil {
		return x1contract.OzonConfig{}, corerepo.MapDB(err)
	}
	cfg.ProductID = productID
	cfg.Values = propsOf(values)
	cfg.FixedTags = row.FixedTags
	cfg.PromptText = row.PromptContent
	_ = json.Unmarshal(ai, &cfg.AI)
	if cfg.AI == (x1contract.AiOutput{}) && len(ai) == 0 {
		cfg.AI = x1contract.DefaultAI()
	}
	cfg.ValidatedCatalogDigest = digest
	cfg.Issues = issues
	cfg.DraftPromptRevision = row.DraftPromptRevision
	cfg.PublishedPromptRevision = row.PublishedPromptRev
	x1contract.FinishOzon(&cfg, x1contract.RowFacts{SourceListed: !row.Archived, SKUPublished: row.Published, NowMS: now})
	// The row already applied product_listability. FinishOzon only sees a partial fact set.
	cfg.Denial = row.Denial
	cfg.Usable = row.Denial == ""
	return cfg, nil
}

func rIdentity(ctx context.Context, tx pgx.Tx, actor contract.Actor) (string, *string, error) {
	var publicID string
	err := tx.QueryRow(ctx, `SELECT public_id FROM public.account_users WHERE id = $1`, actor.UserID).Scan(&publicID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, corerepo.Internal()
	}
	if err != nil {
		return "", nil, corerepo.MapDB(err)
	}
	if actor.Role != "super_admin" {
		return publicID, &publicID, nil
	}
	return publicID, nil, nil
}

func (r X1) PromptDiff(ctx context.Context, actor contract.Actor, sourceID, productID string, revision *int32) (x1contract.PromptDiff, error) {
	var out x1contract.PromptDiff
	err := r.withRead(ctx, actor.OrgID, func(tx pgx.Tx) error {
		_, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		if err := corerepo.RequireSource(ctx, tx, sourceID, owner); err != nil {
			return err
		}
		var pointer *int32
		err = tx.QueryRow(ctx, `SELECT published_revision FROM public.supplier_ozon_configs WHERE product_id = $1`, productID).Scan(&pointer)
		if errors.Is(err, pgx.ErrNoRows) {
			return corerepo.NotFound(corerepo.MissingRow)
		}
		if err != nil {
			return corerepo.MapDB(err)
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM public.sc_products WHERE product_id=$1 AND source_id=$2)`, productID, sourceID).Scan(&exists); err != nil {
			return corerepo.MapDB(err)
		}
		if !exists {
			return corerepo.NotFound(corerepo.MissingRow)
		}
		draftRev := revision
		if draftRev == nil {
			var latest int32
			err = tx.QueryRow(ctx, `SELECT revision FROM public.prompt_revisions WHERE product_id=$1 ORDER BY revision DESC LIMIT 1`, productID).Scan(&latest)
			if errors.Is(err, pgx.ErrNoRows) {
				return corerepo.NotFound(corerepo.MissingRow)
			}
			if err != nil {
				return corerepo.MapDB(err)
			}
			draftRev = &latest
		}
		draft, err := snapshot(ctx, tx, productID, *draftRev)
		if err != nil {
			return err
		}
		var published x1contract.AiOutput
		var publishedBrief string
		var publishedTags []string
		if pointer != nil {
			pub, err := snapshot(ctx, tx, productID, *pointer)
			if err != nil {
				return err
			}
			publishedBrief, publishedTags, published = pub.brief, pub.tags, pub.ai
		} else {
			published = x1contract.DefaultAI()
			publishedTags = []string{}
		}
		out = x1contract.BuildDiff(*draftRev, pointer, publishedBrief, publishedTags, published, draft.brief, draft.tags, draft.ai)
		return nil
	})
	return out, err
}

type snap struct {
	brief string
	tags  []string
	ai    x1contract.AiOutput
}

func snapshot(ctx context.Context, tx pgx.Tx, productID string, revision int32) (snap, error) {
	var out snap
	var tags, ai []byte
	err := tx.QueryRow(ctx, `
		SELECT brief, fixed_tags, ai_output FROM public.prompt_revisions
		 WHERE product_id = $1 AND revision = $2`, productID, revision).Scan(&out.brief, &tags, &ai)
	if errors.Is(err, pgx.ErrNoRows) {
		return snap{}, corerepo.NotFound(corerepo.MissingRow)
	}
	if err != nil {
		return snap{}, corerepo.MapDB(err)
	}
	out.tags = tagsOf(tags)
	_ = json.Unmarshal(ai, &out.ai)
	return out, nil
}

func (r X1) PublishPrompt(ctx context.Context, actor contract.Actor, sourceID, productID string, revision int32, now int64) (x1contract.PromptPublish, error) {
	var out x1contract.PromptPublish
	err := r.withWrite(ctx, actor.OrgID, func(tx pgx.Tx) error {
		publicID, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		if err := corerepo.RequireSource(ctx, tx, sourceID, owner); err != nil {
			return err
		}
		if _, err := corerepo.LockSource(ctx, tx, sourceID); err != nil {
			return err
		}
		if _, _, err := corerepo.LockProduct(ctx, tx, sourceID, productID); err != nil {
			return err
		}
		shot, err := snapshot(ctx, tx, productID, revision)
		if err != nil {
			return err
		}
		terms, err := bannedTx(ctx, tx)
		if err != nil {
			return err
		}
		if x1contract.TagBanned(shot.tags, terms) {
			return &contract.Fail{Kind: contract.KindValidation, Message: "固定标签含受限词，不能发布"}
		}
		var previous *int32
		if err := tx.QueryRow(ctx, `SELECT published_revision FROM public.supplier_ozon_configs WHERE product_id=$1`, productID).Scan(&previous); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return corerepo.NotFound(corerepo.MissingRow)
			}
			return corerepo.MapDB(err)
		}
		var configRev int64
		err = tx.QueryRow(ctx, `
			UPDATE public.supplier_ozon_configs c
			SET prompt_text = r.brief, fixed_tags = r.fixed_tags, ai_output = r.ai_output,
			    published_revision = r.revision, revision = c.revision + 1,
			    updated_at_ms = $3, updated_by_account_uuid = $4
			FROM public.prompt_revisions r
			WHERE c.product_id = $1 AND r.product_id = c.product_id AND r.revision = $2
			  AND c.published_revision IS DISTINCT FROM r.revision
			RETURNING c.revision`, productID, revision, now, publicID).Scan(&configRev)
		if err == nil {
			if _, err := tx.Exec(ctx, `
				UPDATE public.sc_products SET revision = revision + 1, updated_at_ms = $3
				 WHERE source_id = $1 AND product_id = $2`, sourceID, productID, now); err != nil {
				return corerepo.MapDB(err)
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return corerepo.MapDB(err)
		}
		if err := tx.QueryRow(ctx, `SELECT revision FROM public.sc_products WHERE product_id=$1`, productID).Scan(&out.ProductRevision); err != nil {
			return corerepo.MapDB(err)
		}
		if err := tx.QueryRow(ctx, `SELECT revision FROM public.supplier_ozon_configs WHERE product_id=$1`, productID).Scan(&out.ConfigRevision); err != nil {
			return corerepo.MapDB(err)
		}
		out.ProductID = productID
		out.Revision = revision
		out.PublishedRevision = revision
		return corerepo.AuditApplied(ctx, tx, actor, "supplier_dbs", "prompt_revision", productID, "POST", pathPromptPublish, "prompt_revision_published", x1contract.JSONText(struct {
			SourceID string `json:"sourceId"`
			Revision int32  `json:"revision"`
			Previous *int32 `json:"previousRevision"`
		}{sourceID, revision, previous}))
	})
	return out, err
}

func (r X1) PatchPrompt(ctx context.Context, actor contract.Actor, productID string, in x1contract.PromptPatchInput, now int64) (x1contract.Prompt, error) {
	var out x1contract.Prompt
	err := r.withWrite(ctx, actor.OrgID, func(tx pgx.Tx) error {
		publicID, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		var sourceID string
		err = tx.QueryRow(ctx, `
			SELECT p.source_id FROM public.sc_products p
			  JOIN public.sc_sources s ON s.source_id = p.source_id
			 WHERE p.product_id = $1 AND ($2::text IS NULL OR s.created_by_account_uuid = $2)`, productID, owner).Scan(&sourceID)
		if errors.Is(err, pgx.ErrNoRows) {
			return corerepo.NotFound(corerepo.MissingRow)
		}
		if err != nil {
			return corerepo.MapDB(err)
		}
		terms, err := bannedTx(ctx, tx)
		if err != nil {
			return err
		}
		if x1contract.TagBanned(in.Tags, terms) {
			return &contract.Fail{Kind: contract.KindValidation, Message: "固定标签含受限词，不能保存"}
		}
		if _, err := corerepo.LockSource(ctx, tx, sourceID); err != nil {
			return err
		}
		if _, _, err := corerepo.LockProduct(ctx, tx, sourceID, productID); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			UPDATE public.sc_products
			SET prompt_name = $3, prompt_file_name = $4, revision = revision + 1, updated_at_ms = $5
			WHERE product_id = $1 AND revision = $2 AND NOT archived
			  AND EXISTS (
			      SELECT 1 FROM public.supplier_ozon_configs c
			      WHERE c.product_id = sc_products.product_id
			        AND c.description_category_id = sc_products.description_category_id
			        AND c.type_id = sc_products.type_id
			        AND btrim(c.prompt_text) <> ''
			  )`, productID, in.Expected, in.Name, in.FileName, now)
		if err != nil {
			return corerepo.MapDB(err)
		}
		if tag.RowsAffected() == 0 {
			return rowMissing(ctx, tx, sourceID, productID)
		}
		if err := writeRowConfig(ctx, tx, actor, sourceID, productID, in.Content, in.Tags, publicID, now); err != nil {
			return err
		}
		if err := corerepo.AuditApplied(ctx, tx, actor, "supplier_dbs", "supplier_db", productID, "PATCH", pathPromptPatch, "sc_supplier_prompt_updated", x1contract.JSONText(struct {
			Name string   `json:"promptName"`
			File string   `json:"promptFileName"`
			Tags []string `json:"fixedTags"`
		}{in.Name, in.FileName, in.Tags})); err != nil {
			return err
		}
		out, err = loadPrompt(ctx, tx, productID)
		return err
	})
	return out, err
}

func loadPrompt(ctx context.Context, tx pgx.Tx, productID string) (x1contract.Prompt, error) {
	var out x1contract.Prompt
	var tags []byte
	err := tx.QueryRow(ctx, `
		SELECT p.product_id, p.source_id, p.title, p.description_category_id, p.type_id,
		       p.prompt_name, p.prompt_file_name,
		       COALESCE(prompt_latest.brief, m.prompt_text, ''),
		       COALESCE(prompt_latest.fixed_tags, m.fixed_tags, '[]'::jsonb),
		       prompt_latest.revision, m.published_revision, p.revision
		  FROM public.sc_products p
		  LEFT JOIN public.supplier_ozon_configs m ON m.product_id = p.product_id
		  LEFT JOIN LATERAL (
		      SELECT brief, fixed_tags, revision FROM public.prompt_revisions r
		       WHERE r.product_id = p.product_id ORDER BY r.revision DESC LIMIT 1
		  ) prompt_latest ON TRUE
		 WHERE p.product_id = $1`, productID).Scan(
		&out.ProductID, &out.SourceID, &out.ProductTitle, &out.DescriptionCategoryID, &out.TypeID,
		&out.PromptName, &out.PromptFileName, &out.PromptContent, &tags, &out.DraftPromptRevision, &out.PublishedPromptRevision, &out.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return x1contract.Prompt{}, corerepo.NotFound(corerepo.MissingRow)
	}
	if err != nil {
		return x1contract.Prompt{}, corerepo.MapDB(err)
	}
	out.FixedTags = tagsOf(tags)
	return out, nil
}

func bannedTx(ctx context.Context, tx pgx.Tx) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT term FROM public.banned_tags WHERE enabled ORDER BY id`)
	if err != nil {
		return nil, corerepo.MapDB(err)
	}
	defer rows.Close()
	var terms []string
	for rows.Next() {
		var term string
		if err := rows.Scan(&term); err != nil {
			return nil, corerepo.MapDB(err)
		}
		terms = append(terms, term)
	}
	return terms, corerepo.MapDB(rows.Err())
}

func (r X1) SyncPrompts(ctx context.Context, actor contract.Actor, now int64) (x1contract.SyncReport, error) {
	report := x1contract.EmptySync()
	err := r.withWrite(ctx, actor.OrgID, func(tx pgx.Tx) error {
		publicID, _, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			SELECT p.product_id, p.title, p.prompt_file_name, p.prompt_name, p.revision,
			       p.description_category_id, p.type_id,
			       COALESCE(latest.brief, c.prompt_text, ''),
			       COALESCE(latest.fixed_tags, c.fixed_tags, '[]'::jsonb)
			  FROM public.sc_products p
			  JOIN public.supplier_ozon_configs c
			    ON c.product_id = p.product_id
			   AND c.description_category_id = p.description_category_id
			   AND c.type_id = p.type_id
			  LEFT JOIN LATERAL (
			      SELECT brief, fixed_tags FROM public.prompt_revisions r
			       WHERE r.product_id = p.product_id ORDER BY r.revision DESC LIMIT 1
			  ) latest ON TRUE
			 WHERE NOT p.archived AND p.description_category_id > 0 AND p.type_id > 0
			   AND btrim(c.prompt_text) <> ''
			 ORDER BY p.created_at_ms, p.product_id`)
		if err != nil {
			return corerepo.MapDB(err)
		}
		defer rows.Close()
		type candidate struct {
			id, title, file, name, text string
			revision, category, typeID  int64
			tags                        []byte
		}
		var all []candidate
		for rows.Next() {
			var c candidate
			if err := rows.Scan(&c.id, &c.title, &c.file, &c.name, &c.revision, &c.category, &c.typeID, &c.text, &c.tags); err != nil {
				return corerepo.MapDB(err)
			}
			all = append(all, c)
		}
		if err := rows.Err(); err != nil {
			return corerepo.MapDB(err)
		}
		for _, c := range all {
			item := x1contract.SyncItem{ProductID: c.id, ProductTitle: c.title, PromptFileName: c.file, Revision: c.revision}
			var fileN, catN int
			var libName, libFile, libContent string
			var libTags []byte
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM public.category_prompts WHERE file_name = $1`, c.file).Scan(&fileN); err != nil {
				return corerepo.MapDB(err)
			}
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM public.category_prompts WHERE description_category_id = $1 AND type_id = $2`, c.category, c.typeID).Scan(&catN); err != nil {
				return corerepo.MapDB(err)
			}
			if fileN > 1 || catN > 1 {
				pushMiss(&report, item, "ambiguous")
				continue
			}
			if fileN != 1 || catN != 1 {
				pushMiss(&report, item, "no_match")
				continue
			}
			err := tx.QueryRow(ctx, `
				SELECT name, file_name, content, fixed_tags FROM public.category_prompts
				 WHERE file_name = $1 AND description_category_id = $2 AND type_id = $3`, c.file, c.category, c.typeID).Scan(&libName, &libFile, &libContent, &libTags)
			if errors.Is(err, pgx.ErrNoRows) {
				pushMiss(&report, item, "no_match")
				continue
			}
			if err != nil {
				return corerepo.MapDB(err)
			}
			canon, cerr := x1contract.CanonicalBrief(libContent)
			if cerr != nil {
				pushFail(&report, item, "类目提示词还不是六行商品说明，未同步")
				continue
			}
			if c.name == libName && c.text == canon {
				pushUpToDate(&report, item)
				continue
			}
			tags, terr := x1contract.NormalizeTags(tagsOf(libTags), true)
			if terr != nil {
				pushFail(&report, item, terr.Error())
				continue
			}
			if _, err := tx.Exec(ctx, `SAVEPOINT update_supplier_prompt`); err != nil {
				return corerepo.MapDB(err)
			}
			reason := applySync(ctx, tx, actor, c.id, c.revision, libName, libFile, canon, tags, publicID, now)
			if reason != "" {
				_, _ = tx.Exec(ctx, `ROLLBACK TO SAVEPOINT update_supplier_prompt`)
				pushFail(&report, item, reason)
				continue
			}
			if _, err := tx.Exec(ctx, `RELEASE SAVEPOINT update_supplier_prompt`); err != nil {
				return corerepo.MapDB(err)
			}
			fresh, err := loadPrompt(ctx, tx, c.id)
			if err != nil {
				return err
			}
			item.Revision = fresh.Revision
			item.PromptFileName = fresh.PromptFileName
			pushUpdated(&report, item)
		}
		return corerepo.AuditApplied(ctx, tx, actor, "supplier_dbs", "supplier_db", "supplier-prompts", "POST", pathPromptSync, "sc_supplier_prompts_synced", x1contract.JSONText(struct {
			Updated   int `json:"updated"`
			UpToDate  int `json:"upToDate"`
			Unmatched int `json:"unmatched"`
			Failed    int `json:"failed"`
		}{report.Counts.Updated, report.Counts.UpToDate, report.Counts.Unmatched, report.Counts.Failed}))
	})
	return report, err
}

func applySync(ctx context.Context, tx pgx.Tx, actor contract.Actor, productID string, revision int64, name, file, content string, tags []string, publicID string, now int64) string {
	var sourceID string
	if err := tx.QueryRow(ctx, `SELECT source_id FROM public.sc_products WHERE product_id=$1`, productID).Scan(&sourceID); err != nil {
		return "存储暂时不可用"
	}
	tag, err := tx.Exec(ctx, `
		UPDATE public.sc_products
		SET prompt_name = $3, prompt_file_name = $4, revision = revision + 1, updated_at_ms = $5
		WHERE product_id = $1 AND revision = $2 AND NOT archived
		  AND EXISTS (
		      SELECT 1 FROM public.supplier_ozon_configs c
		      WHERE c.product_id = sc_products.product_id
		        AND c.description_category_id = sc_products.description_category_id
		        AND c.type_id = sc_products.type_id
		        AND btrim(c.prompt_text) <> ''
		  )`, productID, revision, name, file, now)
	if err != nil {
		return "存储暂时不可用"
	}
	if tag.RowsAffected() == 0 {
		var archived bool
		_ = tx.QueryRow(ctx, `SELECT archived FROM public.sc_products WHERE product_id=$1`, productID).Scan(&archived)
		if archived {
			return "商品已归档或不存在"
		}
		return "商品已被其他操作更新"
	}
	if err := writeRowConfig(ctx, tx, actor, sourceID, productID, content, tags, publicID, now); err != nil {
		if f, ok := contract.AsFail(err); ok && f.Kind == contract.KindValidation {
			return f.Message
		}
		if f, ok := contract.AsFail(err); ok && f.Kind == contract.KindConflict {
			return "商品已被其他操作更新"
		}
		if f, ok := contract.AsFail(err); ok && f.Kind == contract.KindNotFound {
			return "商品已归档或不存在"
		}
		return "存储暂时不可用"
	}
	if err := corerepo.AuditApplied(ctx, tx, actor, "supplier_dbs", "supplier_db", productID, "PATCH", pathPromptPatch, "sc_supplier_prompt_updated", x1contract.JSONText(struct {
		Name string   `json:"promptName"`
		File string   `json:"promptFileName"`
		Tags []string `json:"fixedTags"`
	}{name, file, tags})); err != nil {
		return "存储暂时不可用"
	}
	return ""
}

func pushMiss(report *x1contract.SyncReport, item x1contract.SyncItem, reason string) {
	report.Counts.Unmatched++
	if len(report.Unmatched) < 200 {
		report.Unmatched = append(report.Unmatched, x1contract.SyncMiss{ProductID: item.ProductID, ProductTitle: item.ProductTitle, PromptFileName: item.PromptFileName, Revision: item.Revision, Reason: reason})
	} else {
		report.DetailsTruncated = true
	}
}

func pushFail(report *x1contract.SyncReport, item x1contract.SyncItem, reason string) {
	report.Counts.Failed++
	if len(report.Failed) < 200 {
		report.Failed = append(report.Failed, x1contract.SyncFailure{ProductID: item.ProductID, ProductTitle: item.ProductTitle, PromptFileName: item.PromptFileName, Revision: item.Revision, Reason: reason})
	} else {
		report.DetailsTruncated = true
	}
}

func pushUpToDate(report *x1contract.SyncReport, item x1contract.SyncItem) {
	report.Counts.UpToDate++
	if len(report.UpToDate) < 200 {
		report.UpToDate = append(report.UpToDate, item)
	} else {
		report.DetailsTruncated = true
	}
}

func pushUpdated(report *x1contract.SyncReport, item x1contract.SyncItem) {
	report.Counts.Updated++
	if len(report.Updated) < 200 {
		report.Updated = append(report.Updated, item)
	} else {
		report.DetailsTruncated = true
	}
}
