package storerepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// LoadRoster is load_roster: one Workspace's whole store roster plus the quota
// projection the SPA paints. The clock is read once so the answer cannot depend
// on how many rows were painted before a given one.
func (r Repo) LoadRoster(ctx context.Context, orgID int64, actor domain.Actor) (domain.Roster, *contract.APIError) {
	var out domain.Roster
	var api *contract.APIError
	err := r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		limit, apiErr := loadStoreLimit(ctx, tx, orgID)
		if apiErr != nil {
			api = apiErr
			return nil
		}
		rows, apiErr := listRowsTx(ctx, tx, orgID, actor)
		if apiErr != nil {
			api = apiErr
			return nil
		}
		used, err := countEffectiveStores(ctx, tx, orgID)
		if err != nil {
			return err
		}
		suspended, err := countSuspended(ctx, tx, orgID)
		if err != nil {
			return err
		}
		revision, err := loadQuotaRevision(ctx, tx, orgID)
		if err != nil {
			return err
		}
		suspendedStores := make([]domain.QuotaChange, 0)
		for _, row := range rows {
			if row.QuotaSuspended {
				suspendedStores = append(suspendedStores, domain.QuotaChange{
					UUID: row.UUID, CreateOrder: row.CreateOrder, Action: domain.ActionSuspend,
				})
			}
		}
		tombstones, err := loadTombstones(ctx, tx, orgID, actor)
		if err != nil {
			return err
		}
		tags, err := loadTagRoster(ctx, tx, orgID, actor)
		if err != nil {
			return err
		}
		groups, err := loadGroupRoster(ctx, tx, orgID, actor)
		if err != nil {
			return err
		}
		out = domain.Roster{
			Stores:               rows,
			Tags:                 tags,
			Groups:               groups,
			StoreLimit:           limit,
			StoresUsed:           used,
			Suspended:            suspended,
			QuotaRevision:        &revision,
			QuotaSuspendedStores: suspendedStores,
			Tombstones:           tombstones,
		}
		return nil
	})
	if err != nil {
		return domain.Roster{}, asAPIError(err, contract.MsgUnavailable)
	}
	if api != nil {
		return domain.Roster{}, api
	}
	return out, nil
}

func listRowsTx(ctx context.Context, tx pgx.Tx, orgID int64, actor domain.Actor) ([]domain.Row, *contract.APIError) {
	rows, err := tx.Query(ctx, `
		SELECT `+projectionColumns+`
		  FROM public.organization_stores s
		 WHERE s.org_id = $1 AND s.deleted_at_ms IS NULL
		   AND ($2 OR s.assignee_membership_id = $3)
		 ORDER BY s.create_order ASC, s.id ASC`,
		orgID, actor.CanManageAll(), actor.MembershipID)
	if err != nil {
		return nil, asAPIError(err, contract.MsgUnavailable)
	}
	defer rows.Close()
	var out []domain.Row
	for rows.Next() {
		row, err := scanProjection(rows)
		if err != nil {
			return nil, asAPIError(err, contract.MsgUnavailable)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, asAPIError(err, contract.MsgUnavailable)
	}
	return out, nil
}

// loadStoreLimit is load_effective_store_quota_limit: the Workspace override
// when set, otherwise the Store pool for the effective tier and seats. A
// missing Workspace is MsgWorkspaceMissing.
func loadStoreLimit(ctx context.Context, tx pgx.Tx, orgID int64) (int64, *contract.APIError) {
	var seatLimit *int64
	var storeOverride *int64
	err := tx.QueryRow(ctx, `
		SELECT seat_limit, store_limit_override FROM public.organizations WHERE id = $1`,
		orgID).Scan(&seatLimit, &storeOverride)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, contract.NotFound(contract.MsgWorkspaceMissing)
	}
	if err != nil {
		return 0, asAPIError(err, contract.MsgUnavailable)
	}
	tier, seats, err := loadSeatState(ctx, tx, orgID)
	if err != nil {
		return 0, asAPIError(err, contract.MsgUnavailable)
	}
	// The admin seat override flows through the same merge the entitlement
	// projection uses, so an admin-granted seat raises the Store pool too.
	if seatLimit != nil && *seatLimit >= 1 {
		seats = *seatLimit
	}
	base := domain.StoreQuotaFor(tier, seats)
	if storeOverride != nil && *storeOverride >= domain.MinStoreLimit {
		return *storeOverride, nil
	}
	if base < domain.MinStoreLimit {
		return domain.MinStoreLimit, nil
	}
	return base, nil
}

// loadSeatState is load_active_seat_state: live lots set the tier and the
// purchased seats.
func loadSeatState(ctx context.Context, tx pgx.Tx, orgID int64) (string, int64, error) {
	if orgID <= 0 {
		return "lite", 0, nil
	}
	rows, err := tx.Query(ctx, `
		WITH clock AS (SELECT clock_timestamp() AS now)
		SELECT tier, COALESCE(SUM(seats), 0)::bigint
		  FROM public.member_seat_lots
		 CROSS JOIN clock
		 WHERE org_id = $1 AND starts_at <= clock.now AND expires_at > clock.now
		 GROUP BY tier`, orgID)
	if err != nil {
		return "", 0, err
	}
	defer rows.Close()
	var seats int64
	var tiers []string
	for rows.Next() {
		var tier string
		var count int64
		if err := rows.Scan(&tier, &count); err != nil {
			return "", 0, err
		}
		seats += count
		tiers = append(tiers, tier)
	}
	if err := rows.Err(); err != nil {
		return "", 0, err
	}
	return effectiveTier(tiers), seats, nil
}

// effectiveTier picks the highest live lot. No lot at all is lite.
func effectiveTier(tiers []string) string {
	best := "lite"
	rank := 0
	for _, tier := range tiers {
		r := 0
		switch tier {
		case "ultra":
			r = 3
		case "max":
			r = 2
		case "pro":
			r = 1
		}
		if r > rank {
			rank = r
			best = tier
		}
	}
	return best
}

// countEffectiveStores is count_effective_stores: a store occupies a slot only
// when neither switch is thrown.
func countEffectiveStores(ctx context.Context, tx pgx.Tx, orgID int64) (int64, error) {
	var count int64
	err := tx.QueryRow(ctx, `
		SELECT COUNT(*)::bigint FROM public.organization_stores
		 WHERE org_id = $1 AND deleted_at_ms IS NULL
		   AND NOT manual_disabled AND NOT quota_suspended`, orgID).Scan(&count)
	return count, err
}

func countSuspended(ctx context.Context, tx pgx.Tx, orgID int64) (int64, error) {
	var count int64
	err := tx.QueryRow(ctx, `
		SELECT COUNT(*)::bigint FROM public.organization_stores
		 WHERE org_id = $1 AND deleted_at_ms IS NULL AND quota_suspended`, orgID).Scan(&count)
	return count, err
}

func loadQuotaRevision(ctx context.Context, tx pgx.Tx, orgID int64) (int64, error) {
	var revision int64
	err := tx.QueryRow(ctx, `SELECT quota_revision FROM public.organizations WHERE id = $1`,
		orgID).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, contract.NotFound(contract.MsgWorkspaceMissing)
	}
	return revision, err
}

// loadTombstones is load_tombstones: deleted Stores in deletion order, minus
// the ones this operator already acknowledged. Rows are retained forever, so
// another operator still sees a tombstone this one consumed.
func loadTombstones(ctx context.Context, tx pgx.Tx, orgID int64, actor domain.Actor) ([]domain.Tombstone, error) {
	rows, err := tx.Query(ctx, `
		SELECT lower(s.uuid::text), s.deleted_at_ms, s.revision
		  FROM public.organization_stores s
		 WHERE s.org_id = $1 AND s.deleted_at_ms IS NOT NULL
		   AND ($2 OR s.assignee_membership_id = $3)
		   AND NOT EXISTS (
		       SELECT 1 FROM public.store_tombstone_consumptions c
		        WHERE c.org_id = s.org_id AND c.store_id = s.id AND c.user_id = $4)
		 ORDER BY s.deleted_at_ms ASC, s.id ASC`,
		orgID, actor.CanManageAll(), actor.MembershipID, actor.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Tombstone, 0)
	for rows.Next() {
		var row domain.Tombstone
		if err := rows.Scan(&row.UUID, &row.DeletedAtMS, &row.Revision); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// loadTagRoster counts only the stores of this org that are live and visible to
// the actor, so a member's tag counts match the stores they can see.
func loadTagRoster(ctx context.Context, tx pgx.Tx, orgID int64, actor domain.Actor) ([]domain.TagView, error) {
	rows, err := tx.Query(ctx, `
		SELECT lower(t.uuid::text), t.name, COUNT(s.id)::bigint
		  FROM public.organization_store_tags t
		  LEFT JOIN public.store_tag_links l ON l.tag_id = t.id
		  LEFT JOIN public.organization_stores s
		         ON s.id = l.store_id AND s.org_id = $1 AND s.deleted_at_ms IS NULL
		        AND ($2 OR s.assignee_membership_id = $3)
		 WHERE t.org_id = $1
		 GROUP BY t.id
		 ORDER BY lower(t.name), t.id`,
		orgID, actor.CanManageAll(), actor.MembershipID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.TagView, 0)
	for rows.Next() {
		var row domain.TagView
		if err := rows.Scan(&row.UUID, &row.Name, &row.StoreCount); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func loadGroupRoster(ctx context.Context, tx pgx.Tx, orgID int64, actor domain.Actor) ([]domain.TagView, error) {
	rows, err := tx.Query(ctx, `
		SELECT lower(g.uuid::text), g.name, COUNT(s.id)::bigint
		  FROM public.organization_store_groups g
		  LEFT JOIN public.organization_stores s
		         ON s.group_id = g.id AND s.org_id = $1 AND s.deleted_at_ms IS NULL
		        AND ($2 OR s.assignee_membership_id = $3)
		 WHERE g.org_id = $1
		 GROUP BY g.id
		 ORDER BY lower(g.name), g.id`,
		orgID, actor.CanManageAll(), actor.MembershipID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.TagView, 0)
	for rows.Next() {
		var row domain.TagView
		if err := rows.Scan(&row.UUID, &row.Name, &row.StoreCount); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
