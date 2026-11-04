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
		judge := x1contract.PendingOzon()
		if in.Validate {
			stamp, err := loadStamp(ctx, tx, in.Category, in.TypeID, in.Language)
			if err != nil {
				return err
			}
			judge, err = r.judgeOzon(ctx, tx, in.Category, in.TypeID, in.Language, in.ValuesJSON, in.ComplexJSON, stamp, now)
			if err != nil {
				return err
			}
		}
		if err := putOzon(ctx, tx, actor, sourceID, productID, in.Category, in.TypeID, in.Language, in.ValuesJSON, in.ComplexJSON, jsonBytes(in.Tags), in.Prompt, jsonBytes(in.AI), judge, in.Expected, publicID, now); err != nil {
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
	var fields json.RawMessage
	err := tx.QueryRow(ctx, `
		SELECT content_digest, fetched_at_ms, fields FROM public.ozon_category_current
		 WHERE description_category_id = $1 AND type_id = $2 AND language = $3 FOR SHARE`, category, typeID, language).Scan(&digest, &fetched, &fields)
	if errors.Is(err, pgx.ErrNoRows) {
		return x1contract.CatalogStamp{}, nil
	}
	if err != nil {
		return x1contract.CatalogStamp{}, corerepo.MapDB(err)
	}
	return x1contract.CatalogStamp{Digest: digest, Fetched: fetched, Present: true, Fields: fields}, nil
}

func readOzon(ctx context.Context, tx pgx.Tx, actor contract.Actor, sourceID, productID string, now int64) (x1contract.OzonConfig, error) {
	_, owner, err := corerepo.Identity(ctx, tx, actor)
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
		SELECT description_category_id, type_id, language, values, complex_values, ai_output, revision, state,
		       validated_catalog_digest, issues, updated_at_ms
		  FROM public.supplier_ozon_configs WHERE product_id = $1`, productID).Scan(
		&cfg.DescriptionCategoryID, &cfg.TypeID, &cfg.Language, &values, &cfg.ComplexValues, &ai, &cfg.Revision, &cfg.State,
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
	x1contract.FinishOzon(&cfg, x1contract.RowFacts{SourceListed: !row.Archived, SKUPublished: row.Published, NowMS: now})
	// The row already applied product_listability. FinishOzon only sees a partial fact set.
	cfg.Denial = row.Denial
	cfg.Usable = row.Denial == ""
	return cfg, nil
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
