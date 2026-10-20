package catalogrepo

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	catcontract "github.com/xxww0098/podhub-go/internal/admin/catalog/contract"
	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	platformseal "github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// CatalogRepo stores platform products and SKUs. These tables have no RLS.
type CatalogRepo struct {
	Pool *pgxpool.Pool
	// Key is CLOUD_INTEGRATION_CONFIG_KEY. It is checked only after a config row exists.
	Key string
}

const productCols = `product_id, title, description, media, specs, published, revision, created_at_ms, updated_at_ms`

const skuCols = `s.sku_id, s.product_id, s.platform_code, s.title, s.media, s.specs, s.lead_time, s.published,
     p.price_cents AS current_price_cents, p.id AS current_price_version_id,
     b.preset_id AS shipping_preset_id, sp.name AS shipping_preset_name,
     sp.current_version AS shipping_required_version,
     s.revision, s.created_at_ms, s.updated_at_ms`

const skuFrom = `public.sc_skus s
     LEFT JOIN LATERAL (
         SELECT id, price_cents FROM public.sc_price_versions
         WHERE sku_id = s.sku_id ORDER BY id DESC LIMIT 1
     ) p ON true
     LEFT JOIN public.shipping_sku_bindings b ON b.sku_id = s.sku_id
     LEFT JOIN public.shipping_presets sp ON sp.preset_id = b.preset_id`

func (r CatalogRepo) read(ctx context.Context, fn func(pgx.Tx) error) error {
	if r.Pool == nil {
		return corecontract.Fail(500, "INTERNAL", "服务暂不可用")
	}
	tx, err := corerepo.BeginAdmin(ctx, r.Pool)
	if err != nil {
		return corerepo.MapAdmin(err, "INTERNAL")
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	if err := fn(tx); err != nil {
		return corerepo.MapAdmin(err, "INTERNAL")
	}
	return corerepo.MapAdmin(tx.Commit(ctx), "INTERNAL")
}

func (r CatalogRepo) write(ctx context.Context, fn func(pgx.Tx) error) error {
	if r.Pool == nil {
		return corecontract.Fail(500, "INTERNAL", "服务暂不可用")
	}
	tx, err := corerepo.BeginAdmin(ctx, r.Pool)
	if err != nil {
		return corerepo.MapAdmin(err, "INTERNAL")
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	defer writer.Forget(tx)
	if err := corerepo.AssertWriteLease(ctx, tx, "平台目录写入未启用"); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return corerepo.MapAdmin(tx.Commit(ctx), "INTERNAL")
}

// Bases is mediaAccounts[].publicBaseUrl. Empty strings are dropped.
// Supplier storage, delegate storage, AI, and payment are not bases.
// A missing row is an empty list and does not consult the key.
func (r CatalogRepo) Bases(ctx context.Context) ([]string, error) {
	if r.Pool == nil {
		return nil, corecontract.Fail(503, "MEDIA_UNAVAILABLE", "服务暂不可用")
	}
	var nonce, ciphertext []byte
	err := r.Pool.QueryRow(ctx, `
		SELECT nonce, ciphertext
		FROM public.platform_integration_config
		WHERE singleton = true`).Scan(&nonce, &ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return []string{}, nil
	}
	if err != nil {
		return nil, mediaReadErr(err)
	}
	key, err := platformseal.IntegrationKEK(r.Key)
	if err != nil {
		var keyErr *platformseal.KeyError
		if errors.As(err, &keyErr) {
			return nil, corecontract.Fail(503, "MEDIA_UNAVAILABLE", keyErr.Message)
		}
		return nil, corecontract.Fail(503, "MEDIA_UNAVAILABLE", "服务暂不可用")
	}
	plain, err := platformseal.OpenIntegration(key, nonce, ciphertext)
	if err != nil {
		return nil, corecontract.Fail(503, "MEDIA_UNAVAILABLE", "服务暂不可用")
	}
	snap, _, err := corecontract.ParseStored(plain)
	if err != nil {
		return nil, corecontract.Fail(503, "MEDIA_UNAVAILABLE", "服务暂不可用")
	}
	out := make([]string, 0, len(snap.Buckets))
	for _, account := range snap.Buckets {
		if account.PublicBase != "" {
			out = append(out, account.PublicBase)
		}
	}
	return out, nil
}

func mediaReadErr(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "55P03" {
		return &corecontract.APIError{Status: 503, Code: "MEDIA_UNAVAILABLE", Message: "资源正在更新，请稍后重试", RetryAfter: "1"}
	}
	return corecontract.Fail(503, "MEDIA_UNAVAILABLE", "服务暂不可用")
}

func (r CatalogRepo) List(ctx context.Context) ([]catcontract.Product, []catcontract.SKU, error) {
	var products []catcontract.Product
	var skus []catcontract.SKU
	err := r.read(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+productCols+` FROM public.sc_products ORDER BY created_at_ms, product_id`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			p, err := scanProduct(rows)
			if err != nil {
				return err
			}
			products = append(products, p)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		rows.Close()
		srows, err := tx.Query(ctx, `SELECT `+skuCols+` FROM `+skuFrom+` ORDER BY s.created_at_ms, s.sku_id`)
		if err != nil {
			return err
		}
		defer srows.Close()
		for srows.Next() {
			s, err := scanSKU(srows)
			if err != nil {
				return err
			}
			skus = append(skus, s)
		}
		return srows.Err()
	})
	return products, skus, err
}

func (r CatalogRepo) CreateProduct(ctx context.Context, actor corecontract.Actor, id string, in catcontract.ProductInput, now int64) (catcontract.Product, error) {
	var row catcontract.Product
	err := r.write(ctx, func(tx pgx.Tx) error {
		media, specs, err := jsonPair(in.Media, in.Specs)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `INSERT INTO public.sc_products
			(product_id, title, description, media, specs, published, revision, created_at_ms, updated_at_ms, created_by_account_uuid)
			VALUES ($1, $2, $3, $4, $5, false, 1, $6, $6, $7)
			RETURNING `+productCols, id, in.Title, in.Description, media, specs, now, actor.PublicID)
		if err != nil {
			return corerepo.MapAdmin(err, "INTERNAL")
		}
		defer rows.Close()
		if !rows.Next() {
			rows.Close()
			return corecontract.Fail(500, "INTERNAL", "服务暂不可用")
		}
		row, err = scanProduct(rows)
		rows.Close()
		if err != nil {
			return corerepo.MapAdmin(err, "INTERNAL")
		}
		return corerepo.InsertAudit(ctx, tx, corerepo.AuditRow{
			OrgID: actor.OrgID, UserID: actor.UserID, Module: "admin", EntityType: "sc_product",
			EntityID: row.ProductID, Method: "POST", Path: "/api/admin/platform-catalog/products",
			Action: "sc_product_created", Message: catcontract.ProductAudit(row.Title, row.Published, row.Revision),
		})
	})
	return row, err
}

func (r CatalogRepo) UpdateProduct(ctx context.Context, actor corecontract.Actor, id string, in catcontract.ProductInput, now int64) (catcontract.Product, error) {
	var row catcontract.Product
	err := r.write(ctx, func(tx pgx.Tx) error {
		if err := requireUnmanagedProduct(ctx, tx, id); err != nil {
			return err
		}
		media, specs, err := jsonPair(in.Media, in.Specs)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `UPDATE public.sc_products
			SET title = $3, description = $4, media = $5, specs = $6, revision = revision + 1, updated_at_ms = $7
			WHERE product_id = $1 AND revision = $2
			RETURNING `+productCols, id, in.Revision, in.Title, in.Description, media, specs, now)
		if err != nil {
			return corerepo.MapAdmin(err, "INTERNAL")
		}
		if !rows.Next() {
			rows.Close()
			return casProduct(ctx, tx, id)
		}
		row, err = scanProduct(rows)
		rows.Close()
		if err != nil {
			return corerepo.MapAdmin(err, "INTERNAL")
		}
		return corerepo.InsertAudit(ctx, tx, corerepo.AuditRow{
			OrgID: actor.OrgID, UserID: actor.UserID, Module: "admin", EntityType: "sc_product",
			EntityID: row.ProductID, Method: "PUT", Path: "/api/admin/platform-catalog/products/{product_id}",
			Action: "sc_product_updated", Message: catcontract.ProductAudit(row.Title, row.Published, row.Revision),
		})
	})
	return row, err
}

func (r CatalogRepo) SetProductPublished(ctx context.Context, actor corecontract.Actor, id string, rev int64, published bool, now int64) (catcontract.Product, error) {
	var row catcontract.Product
	action := "sc_product_unpublished"
	if published {
		action = "sc_product_published"
	}
	err := r.write(ctx, func(tx pgx.Tx) error {
		if err := requireUnmanagedProduct(ctx, tx, id); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `UPDATE public.sc_products
			SET published = $3, revision = revision + 1, updated_at_ms = $4
			WHERE product_id = $1 AND revision = $2
			RETURNING `+productCols, id, rev, published, now)
		if err != nil {
			return corerepo.MapAdmin(err, "INTERNAL")
		}
		if !rows.Next() {
			rows.Close()
			return casProduct(ctx, tx, id)
		}
		row, err = scanProduct(rows)
		rows.Close()
		if err != nil {
			return corerepo.MapAdmin(err, "INTERNAL")
		}
		return corerepo.InsertAudit(ctx, tx, corerepo.AuditRow{
			OrgID: actor.OrgID, UserID: actor.UserID, Module: "admin", EntityType: "sc_product",
			EntityID: row.ProductID, Method: "POST", Path: "/api/admin/platform-catalog/products/{product_id}",
			Action: action, Message: catcontract.ProductAudit(row.Title, row.Published, row.Revision),
		})
	})
	return row, err
}

func (r CatalogRepo) CreateSKU(ctx context.Context, actor corecontract.Actor, id string, in catcontract.SKUInput, now int64) (catcontract.SKU, error) {
	var row catcontract.SKU
	err := r.write(ctx, func(tx pgx.Tx) error {
		if err := requireUnmanagedProduct(ctx, tx, in.ProductID); err != nil {
			return err
		}
		media, specs, err := jsonPair(in.Media, in.Specs)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO public.sc_skus
			(sku_id, product_id, platform_code, title, media, specs, lead_time, published, revision, created_at_ms, updated_at_ms, created_by_account_uuid)
			VALUES ($1, $2, $3, $4, $5, $6, $7, false, 1, $8, $8, $9)`,
			id, in.ProductID, in.PlatformCode, in.Title, media, specs, in.LeadTime, now, actor.PublicID); err != nil {
			return skuWriteErr(err)
		}
		loaded, err := loadSKU(ctx, tx, id)
		if err != nil {
			return err
		}
		if loaded == nil {
			return corecontract.Fail(500, "INTERNAL", "服务暂不可用")
		}
		row = *loaded
		return corerepo.InsertAudit(ctx, tx, corerepo.AuditRow{
			OrgID: actor.OrgID, UserID: actor.UserID, Module: "admin", EntityType: "sc_sku",
			EntityID: row.SKUID, Method: "POST", Path: "/api/admin/platform-catalog/skus",
			Action: "sc_sku_created", Message: catcontract.SKUAudit(row.Title, row.PlatformCode, row.Published, row.Revision, row.CurrentPriceCents),
		})
	})
	return row, err
}

func (r CatalogRepo) UpdateSKU(ctx context.Context, actor corecontract.Actor, id string, in catcontract.SKUInput, now int64) (catcontract.SKU, error) {
	return r.bumpSKU(ctx, actor, id, func(tx pgx.Tx) error {
		if err := requireUnmanagedSKU(ctx, tx, id); err != nil {
			return err
		}
		media, specs, err := jsonPair(in.Media, in.Specs)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE public.sc_skus
			SET title = $3, media = $4, specs = $5, lead_time = $6, revision = revision + 1, updated_at_ms = $7
			WHERE sku_id = $1 AND revision = $2`, id, in.Revision, in.Title, media, specs, in.LeadTime, now)
		if err != nil {
			return corerepo.MapAdmin(err, "INTERNAL")
		}
		if tag.RowsAffected() == 0 {
			return casSKU(ctx, tx, id)
		}
		return nil
	}, "PUT", "/api/admin/platform-catalog/skus/{sku_id}", "sc_sku_updated")
}

func (r CatalogRepo) SetPrice(ctx context.Context, actor corecontract.Actor, id string, rev, cents, now int64) (catcontract.SKU, error) {
	return r.bumpSKU(ctx, actor, id, func(tx pgx.Tx) error {
		if err := requireUnmanagedSKU(ctx, tx, id); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `WITH bumped AS (
			UPDATE public.sc_skus SET revision = revision + 1, updated_at_ms = $3
			WHERE sku_id = $1 AND revision = $2 RETURNING sku_id
		)
		INSERT INTO public.sc_price_versions (sku_id, price_cents, created_at_ms, created_by_account_uuid)
		SELECT $1, $4, $3, $5 FROM bumped`, id, rev, now, cents, actor.PublicID)
		if err != nil {
			return corerepo.MapAdmin(err, "INTERNAL")
		}
		if tag.RowsAffected() == 0 {
			return casSKU(ctx, tx, id)
		}
		return nil
	}, "POST", "/api/admin/platform-catalog/skus/{sku_id}/price", "sc_price_set")
}

func (r CatalogRepo) SetSKUPublished(ctx context.Context, actor corecontract.Actor, id string, rev int64, published bool, now int64) (catcontract.SKU, error) {
	action := "sc_sku_unpublished"
	if published {
		action = "sc_sku_published"
	}
	return r.bumpSKU(ctx, actor, id, func(tx pgx.Tx) error {
		if err := requireUnmanagedSKU(ctx, tx, id); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE public.sc_skus
			SET published = $3, revision = revision + 1, updated_at_ms = $4
			WHERE sku_id = $1 AND revision = $2`, id, rev, published, now)
		if err != nil {
			return corerepo.MapAdmin(err, "INTERNAL")
		}
		if tag.RowsAffected() == 0 {
			return casSKU(ctx, tx, id)
		}
		return nil
	}, "POST", "/api/admin/platform-catalog/skus/{sku_id}", action)
}

func (r CatalogRepo) bumpSKU(ctx context.Context, actor corecontract.Actor, id string, fn func(pgx.Tx) error, method, path, action string) (catcontract.SKU, error) {
	var row catcontract.SKU
	err := r.write(ctx, func(tx pgx.Tx) error {
		if err := fn(tx); err != nil {
			return err
		}
		loaded, err := loadSKU(ctx, tx, id)
		if err != nil {
			return err
		}
		if loaded == nil {
			return corecontract.Fail(500, "INTERNAL", "服务暂不可用")
		}
		row = *loaded
		return corerepo.InsertAudit(ctx, tx, corerepo.AuditRow{
			OrgID: actor.OrgID, UserID: actor.UserID, Module: "admin", EntityType: "sc_sku",
			EntityID: row.SKUID, Method: method, Path: path, Action: action,
			Message: catcontract.SKUAudit(row.Title, row.PlatformCode, row.Published, row.Revision, row.CurrentPriceCents),
		})
	})
	return row, err
}

func (r CatalogRepo) ImageTarget(ctx context.Context, kind, id string) (catcontract.ImageTarget, error) {
	var target catcontract.ImageTarget
	err := r.read(ctx, func(tx pgx.Tx) error {
		var raw []byte
		var q string
		if kind == "sku" {
			q = `SELECT s.revision, s.media, s.title, s.published, s.platform_code, p.price_cents,
				EXISTS (SELECT 1 FROM public.sc_products sp WHERE sp.product_id = s.product_id AND sp.source_id <> 'src_unassigned')
				FROM public.sc_skus s
				LEFT JOIN LATERAL (
					SELECT price_cents FROM public.sc_price_versions WHERE sku_id = s.sku_id ORDER BY id DESC LIMIT 1
				) p ON true
				WHERE s.sku_id = $1`
		} else {
			q = `SELECT revision, media, title, published, ''::text, NULL::bigint,
				(source_id <> 'src_unassigned')
				FROM public.sc_products WHERE product_id = $1`
		}
		var price *int64
		var managed bool
		err := tx.QueryRow(ctx, q, id).Scan(&target.Revision, &raw, &target.Title, &target.Published, &target.PlatformCode, &price, &managed)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		target.Exists = true
		target.Managed = managed
		target.PriceCents = price
		media, bad := jsonStrings(raw)
		target.Media = media
		target.MediaBad = bad
		return nil
	})
	return target, err
}

func (r CatalogRepo) AttachMedia(ctx context.Context, actor corecontract.Actor, kind, id string, rev int64, media []string, now int64) (catcontract.Product, catcontract.SKU, error) {
	raw, err := json.Marshal(media)
	if err != nil {
		return catcontract.Product{}, catcontract.SKU{}, corecontract.Fail(500, "INTERNAL", "服务暂不可用")
	}
	var product catcontract.Product
	var sku catcontract.SKU
	err = r.write(ctx, func(tx pgx.Tx) error {
		if kind == "sku" {
			if err := requireUnmanagedSKU(ctx, tx, id); err != nil {
				return err
			}
			tag, err := tx.Exec(ctx, `UPDATE public.sc_skus
				SET media = $3::jsonb, revision = revision + 1, updated_at_ms = $4
				WHERE sku_id = $1 AND revision = $2`, id, rev, raw, now)
			if err != nil {
				return corerepo.MapAdmin(err, "INTERNAL")
			}
			if tag.RowsAffected() == 0 {
				return casSKU(ctx, tx, id)
			}
			loaded, err := loadSKU(ctx, tx, id)
			if err != nil || loaded == nil {
				return corecontract.Fail(500, "INTERNAL", "服务暂不可用")
			}
			sku = *loaded
			return corerepo.InsertAudit(ctx, tx, corerepo.AuditRow{
				OrgID: actor.OrgID, UserID: actor.UserID, Module: "admin", EntityType: "sc_sku",
				EntityID: sku.SKUID, Method: "POST", Path: "/api/admin/platform-catalog/skus/{sku_id}/images",
				Action: "sc_sku_image_attached", Message: catcontract.SKUAudit(sku.Title, sku.PlatformCode, sku.Published, sku.Revision, sku.CurrentPriceCents),
			})
		}
		if err := requireUnmanagedProduct(ctx, tx, id); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `UPDATE public.sc_products
			SET media = $3::jsonb, revision = revision + 1, updated_at_ms = $4
			WHERE product_id = $1 AND revision = $2
			RETURNING `+productCols, id, rev, raw, now)
		if err != nil {
			return corerepo.MapAdmin(err, "INTERNAL")
		}
		if !rows.Next() {
			rows.Close()
			return casProduct(ctx, tx, id)
		}
		product, err = scanProduct(rows)
		rows.Close()
		if err != nil {
			return corerepo.MapAdmin(err, "INTERNAL")
		}
		return corerepo.InsertAudit(ctx, tx, corerepo.AuditRow{
			OrgID: actor.OrgID, UserID: actor.UserID, Module: "admin", EntityType: "sc_product",
			EntityID: product.ProductID, Method: "POST", Path: "/api/admin/platform-catalog/products/{product_id}/images",
			Action: "sc_product_image_attached", Message: catcontract.ProductAudit(product.Title, product.Published, product.Revision),
		})
	})
	return product, sku, err
}

func requireUnmanagedProduct(ctx context.Context, tx pgx.Tx, id string) error {
	var n int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM public.sc_products WHERE product_id = $1 AND source_id <> 'src_unassigned'`, id).Scan(&n); err != nil {
		return corerepo.MapAdmin(err, "INTERNAL")
	}
	if n > 0 {
		return corecontract.Fail(409, "CONFLICT", "该行由平台货源管理，请在平台货源中操作")
	}
	return nil
}

func requireUnmanagedSKU(ctx context.Context, tx pgx.Tx, id string) error {
	var productID string
	err := tx.QueryRow(ctx, `SELECT product_id FROM public.sc_skus WHERE sku_id = $1`, id).Scan(&productID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return corerepo.MapAdmin(err, "INTERNAL")
	}
	return requireUnmanagedProduct(ctx, tx, productID)
}

func casProduct(ctx context.Context, tx pgx.Tx, id string) error {
	var n int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM public.sc_products WHERE product_id = $1`, id).Scan(&n); err != nil {
		return corerepo.MapAdmin(err, "INTERNAL")
	}
	if n == 0 {
		return corecontract.Fail(404, "NOT_FOUND", "记录不存在或未上架")
	}
	return corecontract.Fail(409, "CONFLICT", "记录已被更新，请刷新后重试")
}

func casSKU(ctx context.Context, tx pgx.Tx, id string) error {
	var n int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM public.sc_skus WHERE sku_id = $1`, id).Scan(&n); err != nil {
		return corerepo.MapAdmin(err, "INTERNAL")
	}
	if n == 0 {
		return corecontract.Fail(404, "NOT_FOUND", "记录不存在或未上架")
	}
	return corecontract.Fail(409, "CONFLICT", "记录已被更新，请刷新后重试")
}

func skuWriteErr(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "23505":
			return corecontract.Fail(409, "CONFLICT", "平台编码已存在")
		case "23503":
			return corecontract.Fail(400, "VALIDATION", "平台商品不存在")
		}
	}
	return corerepo.MapAdmin(err, "INTERNAL")
}

func loadSKU(ctx context.Context, tx pgx.Tx, id string) (*catcontract.SKU, error) {
	rows, err := tx.Query(ctx, `SELECT `+skuCols+` FROM `+skuFrom+` WHERE s.sku_id = $1`, id)
	if err != nil {
		return nil, corerepo.MapAdmin(err, "INTERNAL")
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, nil
	}
	row, err := scanSKU(rows)
	if err != nil {
		return nil, corerepo.MapAdmin(err, "INTERNAL")
	}
	return &row, nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanProduct(row scanner) (catcontract.Product, error) {
	var p catcontract.Product
	var media, specs []byte
	if err := row.Scan(&p.ProductID, &p.Title, &p.Description, &media, &specs, &p.Published, &p.Revision, &p.CreatedAtMS, &p.UpdatedAtMS); err != nil {
		return catcontract.Product{}, err
	}
	p.Media, _ = jsonStrings(media)
	p.Specs = jsonMap(specs)
	return catcontract.FillProduct(p), nil
}

func scanSKU(row scanner) (catcontract.SKU, error) {
	var s catcontract.SKU
	var media, specs []byte
	if err := row.Scan(&s.SKUID, &s.ProductID, &s.PlatformCode, &s.Title, &media, &specs, &s.LeadTime, &s.Published,
		&s.CurrentPriceCents, &s.CurrentPriceVersionID, &s.ShippingPresetID, &s.ShippingPresetName, &s.ShippingRequiredVersion,
		&s.Revision, &s.CreatedAtMS, &s.UpdatedAtMS); err != nil {
		return catcontract.SKU{}, err
	}
	s.Media, _ = jsonStrings(media)
	s.Specs = jsonMap(specs)
	return catcontract.FillSKU(s), nil
}

func jsonPair(media []string, specs map[string]string) ([]byte, []byte, error) {
	if media == nil {
		media = []string{}
	}
	if specs == nil {
		specs = map[string]string{}
	}
	m, err := json.Marshal(media)
	if err != nil {
		return nil, nil, corecontract.Fail(500, "INTERNAL", "服务暂不可用")
	}
	s, err := json.Marshal(specs)
	if err != nil {
		return nil, nil, corecontract.Fail(500, "INTERNAL", "服务暂不可用")
	}
	return m, s, nil
}

func jsonStrings(raw []byte) ([]string, bool) {
	if len(raw) == 0 {
		return []string{}, false
	}
	var out []string
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return []string{}, true
	}
	return out, false
}

func jsonMap(raw []byte) map[string]string {
	out := map[string]string{}
	if len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		return map[string]string{}
	}
	return out
}
