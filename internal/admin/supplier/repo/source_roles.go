package supplierrepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	outcome "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	supcontract "github.com/xxww0098/podhub-go/internal/admin/supplier/contract"
)

// roleGrant names one of the two authorization tables. They stay separate
// tables with separate indexes, separate account kinds, and (for fulfillers)
// a one-active-per-source rule; this only removes the duplicated Go plumbing.
type roleGrant struct {
	table      string
	pkColumn   string
	entity     string
	createPath string
	revokePath string
	createAct  string
	revokeAct  string
	conflict   string
	missing    string
}

var (
	fulfillerGrant = roleGrant{
		table: "sc_source_fulfillers", pkColumn: "fulfiller_id",
		entity:     "supplier_fulfiller",
		createPath: "/api/admin/supplier-dbs/{source_id}/fulfillers",
		revokePath: "/api/admin/supplier-dbs/{source_id}/fulfillers/{fulfiller_id}",
		createAct:  "supplier_fulfiller_granted", revokeAct: "supplier_fulfiller_revoked",
		conflict: "这家货源库已有履约人，请先撤销原履约人",
		missing:  "履约授权不存在",
	}
	catalogManagerGrant = roleGrant{
		table: "sc_catalog_managers", pkColumn: "manager_id",
		entity:     "supplier_catalog_manager",
		createPath: "/api/admin/supplier-dbs/{source_id}/catalog-managers",
		revokePath: "/api/admin/supplier-dbs/{source_id}/catalog-managers/{manager_id}",
		createAct:  "supplier_catalog_manager_granted", revokeAct: "supplier_catalog_manager_revoked",
		missing: "商品负责人授权不存在",
	}
)

// ListFulfillers reads the fulfiller grants of one source.
func (r Portal) ListFulfillers(ctx context.Context, actor outcome.Actor, sourceID string) ([]supcontract.Fulfiller, error) {
	var out []supcontract.Fulfiller
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		if err := sourceExists(ctx, tx, sourceID); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			SELECT f.fulfiller_id::text, f.source_id, f.user_id, u.email, p.name,
			       f.status, f.created_at_ms, f.revoked_at_ms
			  FROM public.sc_source_fulfillers f
			  JOIN public.account_users u ON u.id = f.user_id
			  LEFT JOIN public.account_profiles p ON p.user_id = f.user_id
			 WHERE f.source_id = $1
			 ORDER BY f.created_at_ms, f.fulfiller_id`, sourceID)
		if err != nil {
			return corerepo.MapDB(err)
		}
		defer rows.Close()
		out = []supcontract.Fulfiller{}
		for rows.Next() {
			var row supcontract.Fulfiller
			var name *string
			if err := rows.Scan(&row.FulfillerID, &row.SourceID, &row.UserID, &row.Email, &name,
				&row.Status, &row.CreatedAtMs, &row.RevokedAtMs); err != nil {
				return corerepo.MapDB(err)
			}
			if name != nil {
				row.Name = *name
			}
			out = append(out, row)
		}
		return corerepo.MapDB(rows.Err())
	})
	return out, err
}

// ListCatalogManagers reads the catalog-manager grants of one source.
func (r Portal) ListCatalogManagers(ctx context.Context, actor outcome.Actor, sourceID string) ([]supcontract.CatalogManager, error) {
	var out []supcontract.CatalogManager
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		if err := sourceExists(ctx, tx, sourceID); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			SELECT m.manager_id::text, m.source_id, m.user_id, u.email, p.name,
			       m.status, m.created_at_ms, m.revoked_at_ms
			  FROM public.sc_catalog_managers m
			  JOIN public.account_users u ON u.id = m.user_id
			  LEFT JOIN public.account_profiles p ON p.user_id = m.user_id
			 WHERE m.source_id = $1
			 ORDER BY m.created_at_ms, m.manager_id`, sourceID)
		if err != nil {
			return corerepo.MapDB(err)
		}
		defer rows.Close()
		out = []supcontract.CatalogManager{}
		for rows.Next() {
			var row supcontract.CatalogManager
			var name *string
			if err := rows.Scan(&row.ManagerID, &row.SourceID, &row.UserID, &row.Email, &name,
				&row.Status, &row.CreatedAtMs, &row.RevokedAtMs); err != nil {
				return corerepo.MapDB(err)
			}
			if name != nil {
				row.Name = *name
			}
			out = append(out, row)
		}
		return corerepo.MapDB(rows.Err())
	})
	return out, err
}

// GrantFulfiller gives one supplier account the fulfiller role on one source.
func (r Portal) GrantFulfiller(ctx context.Context, actor outcome.Actor, sourceID string, userID, nowMs int64) (supcontract.Fulfiller, error) {
	var out supcontract.Fulfiller
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		if err := sourceExists(ctx, tx, sourceID); err != nil {
			return err
		}
		if err := grantableAccount(ctx, tx, userID, "supplier", "只能授权供应商账号为履约人"); err != nil {
			return err
		}
		var id string
		err := tx.QueryRow(ctx, `
			INSERT INTO public.sc_source_fulfillers (source_id, user_id, created_by, created_at_ms)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (source_id, user_id) DO UPDATE
			   SET status = 'active', created_by = EXCLUDED.created_by,
			       created_at_ms = EXCLUDED.created_at_ms,
			       revoked_by = NULL, revoked_at_ms = NULL
			 WHERE public.sc_source_fulfillers.status = 'disabled'
			RETURNING fulfiller_id::text`,
			sourceID, userID, actor.UserID, nowMs).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return corerepo.Conflict("该账号已是这家货源库的履约人")
		}
		if err != nil {
			if corerepo.Constraint(err) == "ux_sc_source_fulfillers_one_active" {
				return corerepo.Conflict(fulfillerGrant.conflict)
			}
			return corerepo.MapDB(err)
		}
		row, err := loadFulfiller(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := corerepo.Audit(ctx, tx, actor, "supplier_dbs", fulfillerGrant.entity, id, "POST",
			fulfillerGrant.createPath, fulfillerGrant.createAct, grantAuditBody(sourceID, userID)); err != nil {
			return err
		}
		out = row
		return nil
	})
	return out, err
}

// RevokeFulfiller disables one fulfiller grant. The row is kept because
// delegate_dispatches.fulfiller_id still has to resolve.
func (r Portal) RevokeFulfiller(ctx context.Context, actor outcome.Actor, sourceID, fulfillerID string, nowMs int64) error {
	return r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		return revokeGrant(ctx, tx, actor, fulfillerGrant, sourceID, fulfillerID, nowMs)
	})
}

// GrantCatalogManager gives one platform account the catalog-manager role.
func (r Portal) GrantCatalogManager(ctx context.Context, actor outcome.Actor, sourceID string, userID, nowMs int64) (supcontract.CatalogManager, error) {
	var out supcontract.CatalogManager
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		if err := sourceExists(ctx, tx, sourceID); err != nil {
			return err
		}
		if err := grantableAccount(ctx, tx, userID, "platform", "只能授权平台账号为商品负责人"); err != nil {
			return err
		}
		var id string
		err := tx.QueryRow(ctx, `
			INSERT INTO public.sc_catalog_managers (source_id, user_id, created_by, created_at_ms)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (source_id, user_id) DO UPDATE
			   SET status = 'active', created_by = EXCLUDED.created_by,
			       created_at_ms = EXCLUDED.created_at_ms,
			       revoked_by = NULL, revoked_at_ms = NULL
			 WHERE public.sc_catalog_managers.status = 'disabled'
			RETURNING manager_id::text`,
			sourceID, userID, actor.UserID, nowMs).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return corerepo.Conflict("该账号已是这家货源库的商品负责人")
		}
		if err != nil {
			return corerepo.MapDB(err)
		}
		row, err := loadCatalogManager(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := corerepo.Audit(ctx, tx, actor, "supplier_dbs", catalogManagerGrant.entity, id, "POST",
			catalogManagerGrant.createPath, catalogManagerGrant.createAct, grantAuditBody(sourceID, userID)); err != nil {
			return err
		}
		out = row
		return nil
	})
	return out, err
}

// RevokeCatalogManager disables one catalog-manager grant.
func (r Portal) RevokeCatalogManager(ctx context.Context, actor outcome.Actor, sourceID, managerID string, nowMs int64) error {
	return r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		return revokeGrant(ctx, tx, actor, catalogManagerGrant, sourceID, managerID, nowMs)
	})
}

func sourceExists(ctx context.Context, tx pgx.Tx, sourceID string) error {
	var one int
	err := tx.QueryRow(ctx, `SELECT 1 FROM public.sc_sources WHERE source_id = $1`, sourceID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return corerepo.NotFound("厂家不存在")
	}
	return corerepo.MapDB(err)
}

// grantableAccount refuses a missing, disabled, or wrong-kind account. The
// two tables have opposite audiences on purpose: a fulfiller is a supplier
// account (it signs in to /api/supplier/*), a catalog manager is a platform
// account (it signs in to /api/catalog/*). account_kind is the only source
// of truth for that split.
func grantableAccount(ctx context.Context, tx pgx.Tx, userID int64, wantKind, wrongKind string) error {
	var kind string
	var disabled bool
	err := tx.QueryRow(ctx, `
		SELECT account_kind, disabled_at IS NOT NULL
		  FROM public.account_users WHERE id = $1`, userID).Scan(&kind, &disabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return corerepo.Conflict("该账号不存在")
	}
	if err != nil {
		return corerepo.MapDB(err)
	}
	if disabled {
		return corerepo.Conflict("该账号已停用")
	}
	if kind != wantKind {
		return corerepo.Conflict(wrongKind)
	}
	return nil
}

func revokeGrant(ctx context.Context, tx pgx.Tx, actor outcome.Actor, grant roleGrant, sourceID, id string, nowMs int64) error {
	tag, err := tx.Exec(ctx, `
		UPDATE public.`+grant.table+`
		   SET status = 'disabled', revoked_by = $3, revoked_at_ms = $4
		 WHERE `+grant.pkColumn+` = $1::uuid AND source_id = $2 AND status = 'active'`,
		id, sourceID, actor.UserID, nowMs)
	if err != nil {
		return corerepo.MapDB(err)
	}
	if tag.RowsAffected() == 0 {
		return corerepo.NotFound(grant.missing)
	}
	return corerepo.Audit(ctx, tx, actor, "supplier_dbs", grant.entity, id, "DELETE",
		grant.revokePath, grant.revokeAct, `{}`)
}

func grantAuditBody(sourceID string, userID int64) string {
	return corecontract.JSONText(struct {
		SourceID string `json:"sourceId"`
		UserID   int64  `json:"userId"`
	}{sourceID, userID})
}

func loadFulfiller(ctx context.Context, tx pgx.Tx, id string) (supcontract.Fulfiller, error) {
	var row supcontract.Fulfiller
	var name *string
	err := tx.QueryRow(ctx, `
		SELECT f.fulfiller_id::text, f.source_id, f.user_id, u.email, p.name,
		       f.status, f.created_at_ms, f.revoked_at_ms
		  FROM public.sc_source_fulfillers f
		  JOIN public.account_users u ON u.id = f.user_id
		  LEFT JOIN public.account_profiles p ON p.user_id = f.user_id
		 WHERE f.fulfiller_id = $1::uuid`, id).
		Scan(&row.FulfillerID, &row.SourceID, &row.UserID, &row.Email, &name,
			&row.Status, &row.CreatedAtMs, &row.RevokedAtMs)
	if errors.Is(err, pgx.ErrNoRows) {
		return supcontract.Fulfiller{}, corerepo.NotFound(fulfillerGrant.missing)
	}
	if err != nil {
		return supcontract.Fulfiller{}, corerepo.MapDB(err)
	}
	if name != nil {
		row.Name = *name
	}
	return row, nil
}

func loadCatalogManager(ctx context.Context, tx pgx.Tx, id string) (supcontract.CatalogManager, error) {
	var row supcontract.CatalogManager
	var name *string
	err := tx.QueryRow(ctx, `
		SELECT m.manager_id::text, m.source_id, m.user_id, u.email, p.name,
		       m.status, m.created_at_ms, m.revoked_at_ms
		  FROM public.sc_catalog_managers m
		  JOIN public.account_users u ON u.id = m.user_id
		  LEFT JOIN public.account_profiles p ON p.user_id = m.user_id
		 WHERE m.manager_id = $1::uuid`, id).
		Scan(&row.ManagerID, &row.SourceID, &row.UserID, &row.Email, &name,
			&row.Status, &row.CreatedAtMs, &row.RevokedAtMs)
	if errors.Is(err, pgx.ErrNoRows) {
		return supcontract.CatalogManager{}, corerepo.NotFound(catalogManagerGrant.missing)
	}
	if err != nil {
		return supcontract.CatalogManager{}, corerepo.MapDB(err)
	}
	if name != nil {
		row.Name = *name
	}
	return row, nil
}

// disableSourceRoles stops every active authorization of one account. Called
// from DeleteAccount: a removed member must not keep a fulfiller or
// catalog-manager grant. Rows are disabled, never deleted, because
// delegate_dispatches.fulfiller_id still points at them.
func disableSourceRoles(ctx context.Context, tx pgx.Tx, userID, actorUserID, nowMs int64) error {
	for _, table := range []string{"sc_source_fulfillers", "sc_catalog_managers"} {
		if _, err := tx.Exec(ctx, `
			UPDATE public.`+table+`
			   SET status = 'disabled', revoked_by = $2, revoked_at_ms = $3
			 WHERE user_id = $1 AND status = 'active'`,
			userID, actorUserID, nowMs); err != nil {
			return corerepo.MapDB(err)
		}
	}
	return nil
}
