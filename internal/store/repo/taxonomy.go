package storerepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// CreateGroup inserts one store group inside the caller's write transaction.
func CreateGroup(ctx context.Context, tx pgx.Tx, orgID int64, name string) (domain.TagView, error) {
	var out domain.TagView
	// name_key is a generated lower(btrim(name)) column, so the unique index is
	// case-insensitive while the stored name keeps the caller's casing.
	err := tx.QueryRow(ctx, `
		INSERT INTO public.organization_store_groups (org_id, name)
		VALUES ($1, $2)
		RETURNING lower(uuid::text), name`, orgID, name).Scan(&out.UUID, &out.Name)
	if err != nil {
		if mapped := mapConflict(err); mapped != err {
			return domain.TagView{}, mapped
		}
		return domain.TagView{}, err
	}
	return out, nil
}

// RenameGroup sets a new group name and re-reads the row so StoreCount is live.
func RenameGroup(ctx context.Context, tx pgx.Tx, orgID int64, uuid, name string) (domain.TagView, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		UPDATE public.organization_store_groups
		   SET name = $1, updated_at = clock_timestamp()
		 WHERE org_id = $2 AND uuid = $3::uuid
		RETURNING id`, name, orgID, uuid).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.TagView{}, contract.NotFound(contract.MsgGroupNotFound)
	}
	if err != nil {
		if mapped := mapConflict(err); mapped != err {
			return domain.TagView{}, mapped
		}
		return domain.TagView{}, err
	}
	return loadGroupView(ctx, tx, orgID, id)
}

// DeleteGroup drops one group. organization_stores.group_id is ON DELETE SET
// NULL, so every store — tombstoned included — is un-grouped. The returned
// count is the live stores that were cleared, which is what the audit records.
func DeleteGroup(ctx context.Context, tx pgx.Tx, orgID int64, uuid string) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		SELECT id FROM public.organization_store_groups
		 WHERE org_id = $1 AND uuid = $2::uuid
		 FOR UPDATE`, orgID, uuid).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, contract.NotFound(contract.MsgGroupNotFound)
	}
	if err != nil {
		return 0, err
	}
	var count int64
	// No visibility filter here on purpose: the number reports how many live
	// stores the delete un-grouped, not how many this operator can see.
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*)::bigint FROM public.organization_stores
		 WHERE group_id = $1 AND deleted_at_ms IS NULL`, id).Scan(&count); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM public.organization_store_groups WHERE id = $1`, id); err != nil {
		return 0, err
	}
	return count, nil
}

func loadGroupView(ctx context.Context, tx pgx.Tx, orgID, id int64) (domain.TagView, error) {
	var out domain.TagView
	err := tx.QueryRow(ctx, `
		SELECT lower(g.uuid::text), g.name, COUNT(s.id)::bigint
		  FROM public.organization_store_groups g
		  LEFT JOIN public.organization_stores s
		         ON s.group_id = g.id AND s.org_id = $1 AND s.deleted_at_ms IS NULL
		 WHERE g.id = $2
		 GROUP BY g.id`, orgID, id).Scan(&out.UUID, &out.Name, &out.StoreCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.TagView{}, contract.NotFound(contract.MsgGroupNotFound)
	}
	return out, err
}

// ConsumeTombstone records this operator's acknowledgement of a deleted store
// and returns the store's UUID and revision. Replaying it only refreshes the
// timestamp, so a long-offline desktop can safely retry.
func ConsumeTombstone(ctx context.Context, tx pgx.Tx, orgID, userID int64, uuid string, nowMS int64) (string, int64, int64, error) {
	var storeID int64
	var storeUUID string
	var revision int64
	err := tx.QueryRow(ctx, `
		SELECT id, lower(uuid::text), revision FROM public.organization_stores
		 WHERE uuid = $1::uuid AND org_id = $2 AND deleted_at_ms IS NOT NULL
		 LIMIT 1`, uuid, orgID).Scan(&storeID, &storeUUID, &revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", 0, 0, contract.NotFound(contract.MsgTombstoneMissing)
	}
	if err != nil {
		return "", 0, 0, err
	}
	var consumed int64
	err = tx.QueryRow(ctx, `
		INSERT INTO public.store_tombstone_consumptions (org_id, store_id, user_id, consumed_at_ms)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (org_id, store_id, user_id)
		DO UPDATE SET consumed_at_ms = EXCLUDED.consumed_at_ms, updated_at = clock_timestamp()
		RETURNING consumed_at_ms`, orgID, storeID, userID, nowMS).Scan(&consumed)
	if err != nil {
		return "", 0, 0, err
	}
	return storeUUID, revision, consumed, nil
}
