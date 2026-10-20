package supplierrepo

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	outcome "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
)

func (r Portal) ListPrompts(ctx context.Context, actor outcome.Actor) ([]corecontract.Prompt, error) {
	var out []corecontract.Prompt
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		_, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			SELECT p.product_id, p.source_id, p.title, p.description_category_id, p.type_id,
			       p.prompt_name, p.prompt_file_name,
			       COALESCE((SELECT r.brief FROM public.prompt_revisions r
			                  WHERE r.product_id = p.product_id ORDER BY r.revision DESC LIMIT 1),
			                 c.prompt_text),
			       COALESCE((SELECT r.fixed_tags FROM public.prompt_revisions r
			                  WHERE r.product_id = p.product_id ORDER BY r.revision DESC LIMIT 1),
			                 c.fixed_tags),
			       (SELECT r.revision FROM public.prompt_revisions r
			         WHERE r.product_id = p.product_id ORDER BY r.revision DESC LIMIT 1),
			       c.published_revision, p.revision
			  FROM public.sc_products p
			  JOIN public.supplier_ozon_configs c ON c.product_id = p.product_id
			   AND c.description_category_id = p.description_category_id
			   AND c.type_id = p.type_id
			 WHERE NOT p.archived
			   AND p.description_category_id > 0 AND p.type_id > 0
			   AND btrim(c.prompt_text) <> ''
			   AND ($1::text IS NULL OR (p.created_by_account_uuid = $1 AND EXISTS (
			        SELECT 1 FROM public.sc_sources s WHERE s.source_id = p.source_id
			         AND s.created_by_account_uuid = $1)))
			 ORDER BY p.description_category_id, p.type_id, p.title, p.product_id`, owner)
		if err != nil {
			return corerepo.MapDB(err)
		}
		defer rows.Close()
		out = []corecontract.Prompt{}
		for rows.Next() {
			var row corecontract.Prompt
			var tags []byte
			if err := rows.Scan(&row.ProductID, &row.SourceID, &row.ProductTitle, &row.DescriptionCategoryID, &row.TypeID,
				&row.PromptName, &row.PromptFileName, &row.PromptContent, &tags,
				&row.DraftPromptRevision, &row.PublishedPromptRevision, &row.Revision); err != nil {
				return corerepo.MapDB(err)
			}
			row.FixedTags = []string{}
			if len(tags) > 0 {
				var decoded []string
				if json.Unmarshal(tags, &decoded) == nil && decoded != nil {
					row.FixedTags = decoded
				}
			}
			out = append(out, row)
		}
		return corerepo.MapDB(rows.Err())
	})
	return out, err
}
