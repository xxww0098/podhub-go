package storerepo

import (
	"context"
	"errors"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// Tags is the organization_store_tags directory. Every statement runs inside
// the org's tenant transaction, like the rest of this package.
type Tags struct {
	repo Repo
}

// Tags returns the tag directory over the same pool and tenant opener.
func (r Repo) Tags() Tags { return Tags{repo: r} }

// auditModule and the entity label are the Rust values; changing them changes
// what operators see in the audit log.
const (
	auditModule     = "workspace_stores"
	auditEntityType = "workspace_store_tag"
)

// Create inserts one tag and returns it with StoreCount 0.
func (t Tags) Create(ctx context.Context, orgID, userID int64, name string) (domain.Tag, error) {
	var out domain.Tag
	err := t.repo.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		out = domain.Tag{Name: name}
		err := tx.QueryRow(ctx, `
			INSERT INTO public.organization_store_tags (org_id, name)
			VALUES ($1, $2)
			RETURNING lower(uuid::text)`, orgID, name).Scan(&out.UUID)
		if err != nil {
			return mapTagConflict(err)
		}
		return auditTag(ctx, tx, orgID, userID, out.UUID,
			"POST", "/api/workspaces/stores/tags", "tag_created", out.UUID, name, 0)
	})
	return out, err
}

// Rename sets a new name and re-reads the row so StoreCount is current.
func (t Tags) Rename(ctx context.Context, orgID, userID int64, tagUUID, name string) (domain.Tag, error) {
	var out domain.Tag
	err := t.repo.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var id int64
		err := tx.QueryRow(ctx, `
			UPDATE public.organization_store_tags
			   SET name = $3, updated_at = clock_timestamp()
			 WHERE org_id = $1 AND uuid = $2::uuid
			RETURNING id`, orgID, tagUUID, name).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.ErrTagNotFound
		}
		if err != nil {
			return mapTagConflict(err)
		}
		out, err = loadTag(ctx, tx, orgID, id)
		if err != nil {
			return err
		}
		return auditTag(ctx, tx, orgID, userID, out.UUID,
			"PUT", "/api/workspaces/stores/tags/{uuid}", "tag_renamed", out.UUID, out.Name, out.StoreCount)
	})
	return out, err
}

// Delete removes one tag. store_tag_links rows follow by ON DELETE CASCADE;
// the returned count is how many links the delete removed, which is what the
// audit row records.
func (t Tags) Delete(ctx context.Context, orgID, userID int64, tagUUID string) (domain.TagDeleted, error) {
	var out domain.TagDeleted
	err := t.repo.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var id int64
		err := tx.QueryRow(ctx, `
			SELECT id FROM public.organization_store_tags
			 WHERE org_id = $1 AND uuid = $2::uuid
			 FOR UPDATE`, orgID, tagUUID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.ErrTagNotFound
		}
		if err != nil {
			return err
		}
		var links int64
		if err := tx.QueryRow(ctx,
			`SELECT COUNT(*)::bigint FROM public.store_tag_links WHERE tag_id = $1`, id).Scan(&links); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM public.organization_store_tags WHERE id = $1`, id); err != nil {
			return err
		}
		out = domain.TagDeleted{UUID: tagUUID, Deleted: true}
		return auditTag(ctx, tx, orgID, userID, tagUUID,
			"DELETE", "/api/workspaces/stores/tags/{uuid}", "tag_deleted", tagUUID, "", links)
	})
	return out, err
}

// loadTag re-reads one tag with its live store count. The join counts only
// stores of the same org that are not soft-deleted, matching the Rust view.
func loadTag(ctx context.Context, tx pgx.Tx, orgID, id int64) (domain.Tag, error) {
	var out domain.Tag
	err := tx.QueryRow(ctx, `
		SELECT lower(t.uuid::text), t.name, COUNT(s.id)::bigint
		  FROM public.organization_store_tags t
		  LEFT JOIN public.store_tag_links l ON l.tag_id = t.id
		  LEFT JOIN public.organization_stores s
		         ON s.id = l.store_id AND s.org_id = $1 AND s.deleted_at_ms IS NULL
		 WHERE t.id = $2
		 GROUP BY t.id`, orgID, id).Scan(&out.UUID, &out.Name, &out.StoreCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Tag{}, contract.ErrTagNotFound
	}
	return out, err
}

// auditTag writes the audit row for a tag write. links is the removed link
// count; every action except delete writes 0.
func auditTag(ctx context.Context, tx pgx.Tx, orgID, userID int64, tagUUID, method, path, action, entityID, name string, links int64) error {
	message := `{"uuid":"` + entityID + `","name":"` + name + `"}`
	if action == "tag_deleted" {
		message = `{"uuid":"` + entityID + `","links_removed":` + strconv.FormatInt(links, 10) + `}`
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO audit_logs
		       (org_id, user_id, module, entity_type, entity_id, api_method, api_path,
		        action, status, result, message, shop_id, created_at_ms, created_at,
		        actor_kind, support_grant_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7,
		        $8, 'success', 'applied', $9, NULL,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        clock_timestamp(), 'user', NULL)`,
		orgID, userID, auditModule, auditEntityType, tagUUID, method, path, action, message)
	return err
}

// mapTagConflict turns the unique-name violation into the contract error the
// handler maps to 409.
func mapTagConflict(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" {
		return contract.ErrTagExists
	}
	return err
}
