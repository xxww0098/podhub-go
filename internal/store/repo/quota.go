package storerepo

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

func reconcileStoreQuota(ctx context.Context, tx pgx.Tx, orgID int64) (domain.QuotaChanges, error) {
	out := domain.QuotaChanges{}.Ensure()
	rows, err := tx.Query(ctx, `UPDATE public.organization_stores s
 SET quota_suspended=NOT public.subscription_store_allowed(s.org_id,s.uuid,clock_timestamp()),revision=revision+1,updated_at=clock_timestamp()
 WHERE s.org_id=$1 AND s.deleted_at_ms IS NULL AND NOT s.manual_disabled
 AND s.quota_suspended IS DISTINCT FROM NOT public.subscription_store_allowed(s.org_id,s.uuid,clock_timestamp())
 RETURNING s.uuid::text,s.create_order,s.quota_suspended`, orgID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var c domain.QuotaChange
		var suspended bool
		if err = rows.Scan(&c.UUID, &c.CreateOrder, &suspended); err != nil {
			return out, err
		}
		if suspended {
			c.Action = "quota_suspended"
			out.Suspend = append(out.Suspend, c)
		} else {
			c.Action = "quota_restored"
			out.Restore = append(out.Restore, c)
		}
	}
	return out, rows.Err()
}
