package supplierrepo

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	outcome "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	supcontract "github.com/xxww0098/podhub-go/internal/admin/supplier/contract"
)

const dbNotEmpty = "库内仍有行或被订单/绑定引用的归档行，无法删除"
const missingRow = corerepo.MissingRow

func (r Portal) ListDbs(ctx context.Context, actor outcome.Actor) ([]corecontract.SupplierDb, error) {
	var out []corecontract.SupplierDb
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		_, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		out, err = listDbs(ctx, tx, owner, "")
		return err
	})
	return out, err
}

func (r Portal) CreateDb(ctx context.Context, actor outcome.Actor, in supcontract.NormalizedDb, sourceID string, props []supcontract.PropSeed, nowMs int64, password string) (corecontract.SupplierDb, *string, error) {
	var db corecontract.SupplierDb
	var initial *string
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		publicID, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		prefs := in.ViewPrefs
		if len(prefs) == 0 {
			prefs = []byte(`{}`)
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO public.sc_sources
			       (source_id, name, country, contact, internal_note, listed, icon,
			        accepts_delegate, view_prefs, created_at_ms, updated_at_ms,
			        created_by_account_uuid)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)`,
			sourceID, in.Name, in.Country, in.Contact, in.InternalNote, in.Listed, in.Icon,
			in.AcceptsDelegate, prefs, nowMs, publicID)
		if c := corerepo.Constraint(err); c != "" {
			return corerepo.Conflict("库名称已存在")
		}
		if err != nil {
			return corerepo.MapDB(err)
		}
		for _, prop := range props {
			if err := insertProp(ctx, tx, prop, sourceID, nowMs); err != nil {
				return err
			}
		}
		if err := corerepo.Audit(ctx, tx, actor, "supplier_dbs", "supplier_db", sourceID, "POST", "/api/admin/supplier-dbs", "sc_source_created", corecontract.JSONText(struct {
			Name   string `json:"name"`
			Listed bool   `json:"listed"`
		}{in.Name, in.Listed})); err != nil {
			return err
		}
		if in.AccountEmail != nil {
			memberID, once, err := provision(ctx, tx, actor, sourceID, *in.AccountEmail, nil, password, "/api/admin/supplier-dbs", nowMs, "新建厂家账号需要超级管理员", missingRow)
			if err != nil {
				return err
			}
			initial = once
			_ = memberID
		}
		rows, err := listDbs(ctx, tx, owner, sourceID)
		if err != nil {
			return err
		}
		if len(rows) != 1 {
			return corerepo.NotFound(missingRow)
		}
		db = rows[0]
		return nil
	})
	return db, initial, err
}

func (r Portal) UpdateDb(ctx context.Context, actor outcome.Actor, sourceID string, in supcontract.NormalizedDb, nowMs int64, password string) (corecontract.SupplierDb, *string, error) {
	var db corecontract.SupplierDb
	var initial *string
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		_, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		if err := requireSource(ctx, tx, sourceID, owner); err != nil {
			return err
		}
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		if _, err := lockSource(ctx, tx, sourceID); err != nil {
			return err
		}
		var prefs any
		if !in.KeepViewPrefs {
			prefs = []byte(in.ViewPrefs)
		}
		tag, err := tx.Exec(ctx, `
			UPDATE public.sc_sources
			   SET name = $2, country = $3, contact = $4, internal_note = $5,
			       listed = $6, icon = $7, accepts_delegate = $8,
			       view_prefs = COALESCE($9, view_prefs), updated_at_ms = $10,
			       revision = revision + 1
			 WHERE source_id = $1`,
			sourceID, in.Name, in.Country, in.Contact, in.InternalNote, in.Listed, in.Icon, in.AcceptsDelegate, prefs, nowMs)
		if c := corerepo.Constraint(err); c != "" {
			return corerepo.Conflict("库名称已存在")
		}
		if err != nil {
			return corerepo.MapDB(err)
		}
		if tag.RowsAffected() == 0 {
			return corerepo.NotFound(missingRow)
		}
		if err := corerepo.Audit(ctx, tx, actor, "supplier_dbs", "supplier_db", sourceID, "PUT", "/api/admin/supplier-dbs/{source_id}", "sc_source_updated", corecontract.JSONText(struct {
			Name   string `json:"name"`
			Listed bool   `json:"listed"`
		}{in.Name, in.Listed})); err != nil {
			return err
		}
		if in.AccountEmail != nil {
			once, err := rebind(ctx, tx, actor, sourceID, *in.AccountEmail, password, nowMs)
			if err != nil {
				return err
			}
			initial = once
		}
		rows, err := listDbs(ctx, tx, owner, sourceID)
		if err != nil {
			return err
		}
		if len(rows) != 1 {
			return corerepo.NotFound(missingRow)
		}
		db = rows[0]
		return nil
	})
	return db, initial, err
}

func (r Portal) DeleteDb(ctx context.Context, actor outcome.Actor, sourceID string) error {
	return r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		_, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		if err := requireSource(ctx, tx, sourceID, owner); err != nil {
			return err
		}
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		if _, err := lockSource(ctx, tx, sourceID); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			SELECT s.sku_id, p.product_id
			  FROM public.sc_products p
			  JOIN public.sc_skus s ON s.product_id = p.product_id
			 WHERE p.source_id = $1 AND p.archived
			 ORDER BY p.product_id, s.sku_id`, sourceID)
		if err != nil {
			return corerepo.MapDB(err)
		}
		type pair struct{ sku, product string }
		var archived []pair
		for rows.Next() {
			var p pair
			if err := rows.Scan(&p.sku, &p.product); err != nil {
				rows.Close()
				return corerepo.MapDB(err)
			}
			archived = append(archived, p)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return corerepo.MapDB(err)
		}
		for _, p := range archived {
			ref, err := referenced(ctx, tx, p.sku)
			if err != nil {
				return err
			}
			if ref {
				continue
			}
			if err := deleteSKU(ctx, tx, p.sku, p.product, sourceID); err != nil {
				if corerepo.IsFK(err) {
					continue
				}
				return err
			}
		}
		var n int64
		if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM public.sc_products WHERE source_id = $1`, sourceID).Scan(&n); err != nil {
			return corerepo.MapDB(err)
		}
		if n > 0 {
			return corerepo.Conflict(dbNotEmpty)
		}
		tag, err := tx.Exec(ctx, `DELETE FROM public.sc_sources WHERE source_id = $1`, sourceID)
		if corerepo.IsFK(err) {
			return corerepo.Conflict(dbNotEmpty)
		}
		if err != nil {
			return corerepo.MapDB(err)
		}
		if tag.RowsAffected() == 0 {
			return corerepo.NotFound(missingRow)
		}
		return corerepo.Audit(ctx, tx, actor, "supplier_dbs", "supplier_db", sourceID, "DELETE", "/api/admin/supplier-dbs/{source_id}", "sc_source_deleted", `{}`)
	})
}

func (r Portal) CreateProp(ctx context.Context, actor outcome.Actor, sourceID, propID string, in supcontract.NormalizedProp, nowMs int64) (corecontract.Prop, error) {
	var prop corecontract.Prop
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		_, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		if err := requireSource(ctx, tx, sourceID, owner); err != nil {
			return err
		}
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		if _, err := lockSource(ctx, tx, sourceID); err != nil {
			return err
		}
		position := int64(0)
		if in.Position != nil {
			position = *in.Position
		} else {
			if err := tx.QueryRow(ctx, `
				SELECT COALESCE(MAX(position) + 1, 0) FROM public.sc_source_prop_defs WHERE source_id = $1`, sourceID).Scan(&position); err != nil {
				return corerepo.MapDB(err)
			}
		}
		seed := supcontract.PropSeed{
			PropID: propID, Name: in.Name, Type: in.Type,
			Options: supcontract.OptionsJSON(in.Options), Position: position, SellerVisible: in.SellerVisible,
		}
		if err := insertProp(ctx, tx, seed, sourceID, nowMs); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE public.sc_sources SET schema_revision = schema_revision + 1 WHERE source_id = $1`, sourceID); err != nil {
			return corerepo.MapDB(err)
		}
		if err := corerepo.Audit(ctx, tx, actor, "supplier_dbs", "supplier_db", propID, "POST", "/api/admin/supplier-dbs/{source_id}/props", "sc_prop_def_created", corecontract.JSONText(struct {
			SourceID string `json:"sourceId"`
			Name     string `json:"name"`
		}{sourceID, in.Name})); err != nil {
			return err
		}
		prop = corecontract.Prop{
			PropID: propID, SourceID: sourceID, Name: in.Name, Type: in.Type,
			Options: seed.Options, Position: position, SellerVisible: in.SellerVisible,
			CreatedAtMs: nowMs, UpdatedAtMs: nowMs,
		}
		return nil
	})
	return prop, err
}

func (r Portal) UpdateProp(ctx context.Context, actor outcome.Actor, sourceID, propID string, in supcontract.NormalizedProp, nowMs int64) (corecontract.Prop, error) {
	var prop corecontract.Prop
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		_, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		if err := requireSource(ctx, tx, sourceID, owner); err != nil {
			return err
		}
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		if _, err := lockSource(ctx, tx, sourceID); err != nil {
			return err
		}
		var created int64
		var oldPos int64
		err = tx.QueryRow(ctx, `
			SELECT position, created_at_ms FROM public.sc_source_prop_defs
			 WHERE source_id = $1 AND prop_id = $2`, sourceID, propID).Scan(&oldPos, &created)
		if errors.Is(err, pgx.ErrNoRows) {
			return corerepo.NotFound(missingRow)
		}
		if err != nil {
			return corerepo.MapDB(err)
		}
		position := oldPos
		if in.Position != nil {
			position = *in.Position
		}
		options := supcontract.OptionsJSON(in.Options)
		tag, err := tx.Exec(ctx, `
			UPDATE public.sc_source_prop_defs
			   SET name = $3, type = $4, options = $5, position = $6,
			       seller_visible = $7, updated_at_ms = $8, revision = revision + 1
			 WHERE source_id = $1 AND prop_id = $2`,
			sourceID, propID, in.Name, in.Type, []byte(options), position, in.SellerVisible, nowMs)
		if corerepo.Constraint(err) != "" {
			return corerepo.Conflict("同名属性已存在")
		}
		if err != nil {
			return corerepo.MapDB(err)
		}
		if tag.RowsAffected() == 0 {
			return corerepo.NotFound(missingRow)
		}
		if _, err := tx.Exec(ctx, `UPDATE public.sc_sources SET schema_revision = schema_revision + 1 WHERE source_id = $1`, sourceID); err != nil {
			return corerepo.MapDB(err)
		}
		if err := corerepo.Audit(ctx, tx, actor, "supplier_dbs", "supplier_db", propID, "PUT", "/api/admin/supplier-dbs/{source_id}/props/{prop_id}", "sc_prop_def_updated", corecontract.JSONText(struct {
			SourceID string `json:"sourceId"`
			Name     string `json:"name"`
		}{sourceID, in.Name})); err != nil {
			return err
		}
		prop = corecontract.Prop{
			PropID: propID, SourceID: sourceID, Name: in.Name, Type: in.Type,
			Options: options, Position: position, SellerVisible: in.SellerVisible,
			CreatedAtMs: created, UpdatedAtMs: nowMs,
		}
		return nil
	})
	return prop, err
}

func (r Portal) DeleteProp(ctx context.Context, actor outcome.Actor, sourceID, propID string) (int64, error) {
	var n int64
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		_, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		if err := requireSource(ctx, tx, sourceID, owner); err != nil {
			return err
		}
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		if _, err := lockSource(ctx, tx, sourceID); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			SELECT COUNT(*) FROM public.sc_products
			 WHERE source_id = $1 AND jsonb_exists(props, $2)
			   AND ($3::text IS NULL OR created_by_account_uuid = $3)`, sourceID, propID, owner).Scan(&n); err != nil {
			return corerepo.MapDB(err)
		}
		tag, err := tx.Exec(ctx, `DELETE FROM public.sc_source_prop_defs WHERE source_id = $1 AND prop_id = $2`, sourceID, propID)
		if err != nil {
			return corerepo.MapDB(err)
		}
		if tag.RowsAffected() == 0 {
			return corerepo.NotFound(missingRow)
		}
		if _, err := tx.Exec(ctx, `UPDATE public.sc_sources SET schema_revision = schema_revision + 1 WHERE source_id = $1`, sourceID); err != nil {
			return corerepo.MapDB(err)
		}
		return corerepo.Audit(ctx, tx, actor, "supplier_dbs", "supplier_db", propID, "DELETE", "/api/admin/supplier-dbs/{source_id}/props/{prop_id}", "sc_prop_def_deleted", corecontract.JSONText(struct {
			SourceID       string `json:"sourceId"`
			RowsWithValues int64  `json:"rowsWithValues"`
		}{sourceID, n}))
	})
	return n, err
}

func (r Portal) DeleteRow(ctx context.Context, actor outcome.Actor, sourceID, productID string, nowMs int64) error {
	return r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		_, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		var found string
		err = tx.QueryRow(ctx, `
			SELECT p.product_id FROM public.sc_products p
			 JOIN public.sc_sources s ON s.source_id = p.source_id
			 WHERE p.product_id = $1 AND ($2::text IS NULL OR p.source_id = $2)
			   AND ($3::text IS NULL OR (p.created_by_account_uuid = $3 AND s.created_by_account_uuid = $3))`,
			productID, sourceID, owner).Scan(&found)
		if errors.Is(err, pgx.ErrNoRows) {
			return corerepo.NotFound(missingRow)
		}
		if err != nil {
			return corerepo.MapDB(err)
		}
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		if _, err := lockSource(ctx, tx, sourceID); err != nil {
			return err
		}
		sku, published, err := lockProduct(ctx, tx, sourceID, productID)
		if err != nil {
			return err
		}
		ref, err := referenced(ctx, tx, sku)
		if err != nil {
			return err
		}
		if ref && published {
			return corerepo.Conflict("该行已被引用，请先下架")
		}
		if ref {
			tag, err := tx.Exec(ctx, `
				UPDATE public.sc_products SET archived = true, published = false,
				       revision = revision + 1, updated_at_ms = $3
				 WHERE product_id = $1 AND source_id = $2`, productID, sourceID, nowMs)
			if err != nil {
				return corerepo.MapDB(err)
			}
			if tag.RowsAffected() == 0 {
				return corerepo.NotFound(missingRow)
			}
			return corerepo.Audit(ctx, tx, actor, "supplier_dbs", "supplier_db", productID, "DELETE", "/api/admin/supplier-dbs/{source_id}/rows/{product_id}", "sc_source_row_archived", `{"productId":`+jsonQuote(productID)+`}`)
		}
		if err := deleteSKU(ctx, tx, sku, productID, sourceID); err != nil {
			if corerepo.IsFK(err) {
				return corerepo.Conflict("该行已被引用，请先下架")
			}
			return err
		}
		return corerepo.Audit(ctx, tx, actor, "supplier_dbs", "supplier_db", productID, "DELETE", "/api/admin/supplier-dbs/{source_id}/rows/{product_id}", "sc_source_row_deleted", `{"productId":`+jsonQuote(productID)+`}`)
	})
}

func listDbs(ctx context.Context, tx pgx.Tx, owner *string, only string) ([]corecontract.SupplierDb, error) {
	return corerepo.ListDbs(ctx, tx, owner, only)
}

func requireSource(ctx context.Context, tx pgx.Tx, sourceID string, owner *string) error {
	return corerepo.RequireSource(ctx, tx, sourceID, owner)
}

func lockSource(ctx context.Context, tx pgx.Tx, sourceID string) (int64, error) {
	return corerepo.LockSource(ctx, tx, sourceID)
}

func lockProduct(ctx context.Context, tx pgx.Tx, sourceID, productID string) (sku string, published bool, err error) {
	return corerepo.LockProduct(ctx, tx, sourceID, productID)
}

func insertProp(ctx context.Context, tx pgx.Tx, prop supcontract.PropSeed, sourceID string, nowMs int64) error {
	options := prop.Options
	if len(options) == 0 {
		options = []byte(`[]`)
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO public.sc_source_prop_defs
		       (prop_id, source_id, name, type, options, position, seller_visible, created_at_ms, updated_at_ms)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
		prop.PropID, sourceID, prop.Name, prop.Type, []byte(options), prop.Position, prop.SellerVisible, nowMs)
	if corerepo.Constraint(err) != "" {
		return corerepo.Conflict("同名属性已存在")
	}
	return corerepo.MapDB(err)
}

func referenced(ctx context.Context, tx pgx.Tx, skuID string) (bool, error) {
	var n int64
	err := tx.QueryRow(ctx, `
		SELECT
		  (SELECT COUNT(*) FROM public.sc_listing_bindings WHERE platform_sku_id = $1) +
		  (SELECT COUNT(*) FROM public.sc_order_quotes WHERE platform_sku_id = $1) +
		  (SELECT COUNT(*) FROM public.sc_orders WHERE platform_sku_id = $1) +
		  (SELECT COUNT(*) FROM public.sc_order_lines WHERE platform_sku_id = $1) +
		  (SELECT COUNT(*) FROM public.sc_price_versions WHERE sku_id = $1)`, skuID).Scan(&n)
	if err != nil {
		return false, corerepo.MapDB(err)
	}
	return n > 0, nil
}

func deleteSKU(ctx context.Context, tx pgx.Tx, skuID, productID, sourceID string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM public.sc_source_offers WHERE sku_id = $1`, skuID); err != nil {
		return corerepo.MapDB(err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM public.sc_skus WHERE sku_id = $1`, skuID); err != nil {
		if corerepo.IsFK(err) {
			return err
		}
		return corerepo.MapDB(err)
	}
	_, err := tx.Exec(ctx, `DELETE FROM public.sc_products WHERE product_id = $1 AND source_id = $2`, productID, sourceID)
	if corerepo.IsFK(err) {
		return err
	}
	return corerepo.MapDB(err)
}

func jsonQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
