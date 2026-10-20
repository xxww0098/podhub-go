package billingrepo

import (
	"context"
	"sort"

	"github.com/jackc/pgx/v5"
)

// StoreSeat is one organization_stores row the quota pass looks at.
type StoreSeat struct {
	ID      int64
	Order   int64
	Manual  bool
	Deleted bool
}

// PlanStoreSuspension decides quota_suspended for live stores that are not
// manual_disabled. Manual and deleted rows are omitted: the caller must not
// flip them. limit is the override when set, otherwise plans.max_stores.
// A missing plan passes 0, which suspends every live non-manual store.
// Order is create_order, then id. The first limit stores stay unsuspended.
func PlanStoreSuspension(limit int64, rows []StoreSeat) map[int64]bool {
	type live struct {
		id    int64
		order int64
	}
	var keep []live
	for _, row := range rows {
		if row.Manual || row.Deleted {
			continue
		}
		keep = append(keep, live{id: row.ID, order: row.Order})
	}
	sort.Slice(keep, func(i, j int) bool {
		if keep[i].order != keep[j].order {
			return keep[i].order < keep[j].order
		}
		return keep[i].id < keep[j].id
	})
	out := make(map[int64]bool, len(keep))
	for i, row := range keep {
		out[row.id] = int64(i) >= limit
	}
	return out
}

// ReconcileStores applies the projection's store limit inside the caller's
// transaction. The limit now comes from organizations.store_limit, which
// ProjectSubscription writes from the subscription; there is no second
// override column and no per-seat multiplier.
//
// It is kept for callers that only need the store half (admin seat preview);
// the projection uses ReconcileSubscriptionCapacity, which also knows about
// the drain set.
func ReconcileStores(ctx context.Context, tx pgx.Tx, orgID int64) error {
	_, err := tx.Exec(ctx, `
		WITH lim AS (
		    SELECT store_limit AS n FROM organizations WHERE id = $1
		),
		live AS (
		    SELECT s.id,
		           row_number() OVER (ORDER BY s.create_order, s.id) AS rn
		      FROM organization_stores s
		     WHERE s.org_id = $1
		       AND s.deleted_at_ms IS NULL
		       AND NOT s.manual_disabled
		)
		UPDATE organization_stores s
		   SET quota_suspended = (live.rn > lim.n),
		       updated_at = clock_timestamp()
		  FROM live, lim
		 WHERE s.id = live.id
		   AND s.quota_suspended IS DISTINCT FROM (live.rn > lim.n)`, orgID)
	return err
}
