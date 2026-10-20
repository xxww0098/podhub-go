package service

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// Official is one ozon_listing_field_templates row.
type Official struct {
	ID          int64
	CategoryID  string
	Name        string
	Status      string
	Defaults    string
	Dataset     string
	PublishedAt int64
	UpdatedAt   int64
}

// PackageWrite is the POST/PUT body after JSON defaults are filled.
type PackageWrite struct {
	CategoryID string
	Name       string
	Defaults   string
	Dataset    string
}

const packageCols = `id, category_id, name, status, defaults_json, dataset_json, published_at, updated_at_ms`

func scanOfficial(row pgx.Row) (Official, error) {
	var o Official
	err := row.Scan(&o.ID, &o.CategoryID, &o.Name, &o.Status, &o.Defaults, &o.Dataset, &o.PublishedAt, &o.UpdatedAt)
	return o, err
}

// ReadOfficial loads one official package. A missing row is a nil pointer, not an error.
func (d Deps) ReadOfficial(ctx context.Context, actor Actor, category string) (*Official, error) {
	category = strings.TrimSpace(category)
	if category == "" {
		return nil, fail(400, "VALIDATION", "category_id 无效")
	}
	if d.Pool == nil {
		return nil, fail(500, "INTERNAL", "服务暂不可用")
	}
	o, err := scanOfficial(d.Pool.QueryRow(ctx, `SELECT `+packageCols+`
FROM ozon_listing_field_templates WHERE category_id = $1 AND scope = $2 LIMIT 1`, category, "official"))
	found := true
	var out *Official
	if errors.Is(err, pgx.ErrNoRows) {
		found = false
	} else if err != nil {
		return nil, mapDB(err, 500, "INTERNAL", "服务暂不可用")
	} else {
		out = &o
	}
	if err := d.audit(ctx, 0, actor.UserID, "admin", "official_package", category, "GET", "/api/admin/listing/packages/official", "official_package_read", map[string]any{
		"found":   found,
		"summary": "读取官方字段包 " + category,
	}); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateOfficial inserts a published official package.
func (d Deps) CreateOfficial(ctx context.Context, actor Actor, in PackageWrite) (Official, error) {
	var out Official
	err := d.under(ctx, "管理域写入未启用", func(g *gate) error {
		row, err := d.insertOfficial(ctx, g, in)
		if err != nil {
			return err
		}
		out = row
		return g.audit(ctx, 0, actor.UserID, "admin", "official_package", strconv.FormatInt(row.ID, 10), "POST", "/api/admin/listing/packages/official", "official_package_created", map[string]any{
			"category_id": row.CategoryID,
			"summary":     "创建官方字段包 " + row.Name + " (" + row.CategoryID + ")",
		})
	})
	return out, err
}

func (d Deps) insertOfficial(ctx context.Context, g *gate, in PackageWrite) (Official, error) {
	name, err := domain.PackageName(in.Name)
	if err != nil {
		return Official{}, fail(400, "VALIDATION", err.Error())
	}
	if err := domain.JSONObject(in.Defaults); err != nil {
		return Official{}, fail(400, "VALIDATION", err.Error())
	}
	if err := domain.JSONArray(in.Dataset); err != nil {
		return Official{}, fail(400, "VALIDATION", err.Error())
	}
	category := strings.TrimSpace(in.CategoryID)
	var snap int64
	err = g.tx.QueryRow(ctx, `SELECT id FROM ozon_listing_schema_snapshots
WHERE category_id = $1 ORDER BY updated_at_ms DESC, id DESC LIMIT 1`, category).Scan(&snap)
	if errors.Is(err, pgx.ErrNoRows) {
		return Official{}, fail(400, "VALIDATION", "该类目尚无 Schema 快照，请先同步 Schema")
	}
	if err != nil {
		return Official{}, err
	}
	now := d.nowMS()
	row, err := scanOfficial(g.tx.QueryRow(ctx, `INSERT INTO ozon_listing_field_templates
    (org_id, name, category_id, status, defaults_json, dataset_json,
     scope, published_at, clone_of_id, created_at_ms, updated_at_ms, schema_snapshot_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $8, $8, $9)
RETURNING `+packageCols, int64(0), name, category, "published", in.Defaults, in.Dataset, "official", now, snap))
	if unique(err) {
		return Official{}, fail(409, "CONFLICT", "该类目已有官方默认字段，请替换现有的而非新建")
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Official{}, fail(500, "INTERNAL", "创建官方默认字段失败")
	}
	return row, err
}

// ReplaceOfficial updates one official package when the category matches.
func (d Deps) ReplaceOfficial(ctx context.Context, actor Actor, id int64, in PackageWrite) (Official, error) {
	var out Official
	err := d.under(ctx, "管理域写入未启用", func(g *gate) error {
		name, err := domain.PackageName(in.Name)
		if err != nil {
			return fail(400, "VALIDATION", err.Error())
		}
		if err := domain.JSONObject(in.Defaults); err != nil {
			return fail(400, "VALIDATION", err.Error())
		}
		if err := domain.JSONArray(in.Dataset); err != nil {
			return fail(400, "VALIDATION", err.Error())
		}
		category := strings.TrimSpace(in.CategoryID)
		existing, err := scanOfficial(g.tx.QueryRow(ctx, `SELECT `+packageCols+`
FROM ozon_listing_field_templates WHERE id = $1 AND scope = $2 LIMIT 1`, id, "official"))
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && existing.CategoryID != category) {
			return fail(404, "NOT_FOUND", "官方默认字段不存在")
		}
		if err != nil {
			return err
		}
		var snap int64
		err = g.tx.QueryRow(ctx, `SELECT id FROM ozon_listing_schema_snapshots
WHERE category_id = $1 ORDER BY updated_at_ms DESC, id DESC LIMIT 1`, category).Scan(&snap)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(400, "VALIDATION", "该类目尚无 Schema 快照，请先同步 Schema")
		}
		if err != nil {
			return err
		}
		now := d.nowMS()
		out, err = scanOfficial(g.tx.QueryRow(ctx, `UPDATE ozon_listing_field_templates
SET name = $1, defaults_json = $2, dataset_json = $3, updated_at_ms = $4, published_at = $4, schema_snapshot_id = $7
WHERE id = $5 AND scope = $6
RETURNING `+packageCols, name, in.Defaults, in.Dataset, now, id, "official", snap))
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "官方默认字段不存在")
		}
		if err != nil {
			return err
		}
		return g.audit(ctx, 0, actor.UserID, "admin", "official_package", strconv.FormatInt(out.ID, 10), "PUT", "/api/admin/listing/packages/official/{id}", "official_package_replaced", map[string]any{
			"summary": "替换官方字段包 " + out.Name + " (" + out.CategoryID + ")",
		})
	})
	return out, err
}

// DeleteOfficial removes one official package when the category matches.
func (d Deps) DeleteOfficial(ctx context.Context, actor Actor, id int64, category string) error {
	category = strings.TrimSpace(category)
	if category == "" {
		return fail(400, "VALIDATION", "category_id 无效")
	}
	return d.under(ctx, "管理域写入未启用", func(g *gate) error {
		existing, err := scanOfficial(g.tx.QueryRow(ctx, `SELECT `+packageCols+`
FROM ozon_listing_field_templates WHERE id = $1 AND scope = $2 LIMIT 1`, id, "official"))
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && existing.CategoryID != category) {
			return fail(404, "NOT_FOUND", "官方默认字段不存在")
		}
		if err != nil {
			return err
		}
		tag, err := g.tx.Exec(ctx, `DELETE FROM ozon_listing_field_templates
WHERE id = $1 AND scope = $2 AND category_id = $3`, id, "official", category)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return fail(404, "NOT_FOUND", "官方默认字段不存在")
		}
		return g.audit(ctx, 0, actor.UserID, "admin", "official_package", strconv.FormatInt(id, 10), "DELETE", "/api/admin/listing/packages/official/{id}", "official_package_deleted", map[string]any{
			"category_id": category,
			"summary":     "删除官方字段包 #" + strconv.FormatInt(id, 10),
		})
	})
}
