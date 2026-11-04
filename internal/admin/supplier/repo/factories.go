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

const factoryFields = `factory_id, name, country, contact, internal_note, icon, created_at_ms, updated_at_ms`

func scanFactory(row pgx.Row) (supcontract.Factory, error) {
	f := supcontract.Factory{Libraries: []supcontract.FactoryLibrary{}}
	err := row.Scan(&f.FactoryID, &f.Name, &f.Country, &f.Contact, &f.InternalNote, &f.Icon, &f.CreatedAtMs, &f.UpdatedAtMs)
	return f, err
}

func (r Portal) ListFactories(ctx context.Context, actor outcome.Actor) ([]supcontract.Factory, error) {
	var out []supcontract.Factory
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+factoryFields+`, COALESCE((
			SELECT jsonb_agg(jsonb_build_object('source_id', s.source_id, 'name', s.name, 'country', s.country, 'icon', s.icon) ORDER BY s.name, s.source_id)
			FROM public.sc_sources s WHERE s.factory_id=f.factory_id), '[]'::jsonb)
			FROM public.sc_factories f ORDER BY name, factory_id`)
		if err != nil {
			return corerepo.MapDB(err)
		}
		defer rows.Close()
		out = []supcontract.Factory{}
		for rows.Next() {
			var f supcontract.Factory
			var libraries []byte
			if err := rows.Scan(&f.FactoryID, &f.Name, &f.Country, &f.Contact, &f.InternalNote, &f.Icon, &f.CreatedAtMs, &f.UpdatedAtMs, &libraries); err != nil {
				return corerepo.MapDB(err)
			}
			if err := json.Unmarshal(libraries, &f.Libraries); err != nil {
				return corerepo.Internal()
			}
			out = append(out, f)
		}
		return corerepo.MapDB(rows.Err())
	})
	return out, err
}

func (r Portal) CreateFactory(ctx context.Context, actor outcome.Actor, in supcontract.FactoryInput, id string, nowMs int64, password, passwordHash string) (supcontract.Factory, *string, error) {
	var out supcontract.Factory
	var initial *string
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		if actor.Role != "super_admin" {
			return corerepo.Forbidden("创建工厂需要超级管理员")
		}
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		publicID, _, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		out, err = scanFactory(tx.QueryRow(ctx, `INSERT INTO public.sc_factories
			(factory_id, name, country, contact, internal_note, icon, created_by_account_uuid, created_at_ms, updated_at_ms)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING `+factoryFields,
			id, in.Name, in.Country, in.Contact, in.InternalNote, in.Icon, publicID, nowMs))
		if corerepo.Constraint(err) != "" {
			return corerepo.Conflict("工厂名称已存在")
		}
		if err != nil {
			return corerepo.MapDB(err)
		}
		_, initial, err = provision(ctx, tx, actor, id, in.AccountEmail, nil, password, passwordHash, "/api/admin/factories", nowMs, "创建工厂需要超级管理员", "工厂不存在")
		if err != nil {
			return err
		}
		return corerepo.Audit(ctx, tx, actor, "supplier_portal", "factory", id, "POST", "/api/admin/factories", "factory_created", corecontract.JSONText(struct {
			Name string `json:"name"`
		}{in.Name}))
	})
	return out, initial, err
}

func (r Portal) UpdateFactory(ctx context.Context, actor outcome.Actor, id string, in supcontract.FactoryInput, nowMs int64) (supcontract.Factory, error) {
	var out supcontract.Factory
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		if actor.Role != "super_admin" {
			return corerepo.Forbidden("修改工厂需要超级管理员")
		}
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		var err error
		out, err = scanFactory(tx.QueryRow(ctx, `UPDATE public.sc_factories SET name=$2, country=$3, contact=$4, internal_note=$5, icon=$6, updated_at_ms=$7
			WHERE factory_id=$1 RETURNING `+factoryFields, id, in.Name, in.Country, in.Contact, in.InternalNote, in.Icon, nowMs))
		if errors.Is(err, pgx.ErrNoRows) {
			return corerepo.NotFound("工厂不存在")
		}
		if corerepo.Constraint(err) != "" {
			return corerepo.Conflict("工厂名称已存在")
		}
		if err != nil {
			return corerepo.MapDB(err)
		}
		return corerepo.Audit(ctx, tx, actor, "supplier_portal", "factory", id, "PUT", "/api/admin/factories/{factory_id}", "factory_updated", `{}`)
	})
	return out, err
}

func (r Portal) DeleteFactory(ctx context.Context, actor outcome.Actor, id string) error {
	return r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		if actor.Role != "super_admin" {
			return corerepo.Forbidden("删除工厂需要超级管理员")
		}
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		var bound bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM public.sc_sources WHERE factory_id=$1)`, id).Scan(&bound); err != nil {
			return corerepo.MapDB(err)
		}
		if bound {
			return corerepo.Conflict("工厂已绑定商品库，不能删除")
		}
		if _, err := tx.Exec(ctx, `DELETE FROM public.sc_factory_members WHERE factory_id=$1`, id); err != nil {
			return corerepo.MapDB(err)
		}
		tag, err := tx.Exec(ctx, `DELETE FROM public.sc_factories WHERE factory_id=$1`, id)
		if corerepo.IsFK(err) {
			return corerepo.Conflict("工厂已绑定商品库，不能删除")
		}
		if err != nil {
			return corerepo.MapDB(err)
		}
		if tag.RowsAffected() == 0 {
			return corerepo.NotFound("工厂不存在")
		}
		return corerepo.Audit(ctx, tx, actor, "supplier_portal", "factory", id, "DELETE", "/api/admin/factories/{factory_id}", "factory_deleted", `{}`)
	})
}
