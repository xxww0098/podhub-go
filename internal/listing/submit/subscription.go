package submit

import (
	"context"
	"github.com/jackc/pgx/v5"
	"time"
)

// This gates new intent creation only; accepted work and receipts use their existing intent.
func requireStoreSubscription(ctx context.Context, tx pgx.Tx, orgID, userID int64, storeID string, now time.Time) error {
	if now.IsZero() {
		now = time.Now()
	}
	var allowed bool
	if err := tx.QueryRow(ctx, `SELECT public.subscription_store_allowed($1,$2::uuid,$3) AND ($4::bigint=0 OR EXISTS(SELECT 1 FROM organization_members m WHERE m.org_id=$1 AND m.user_id=$4 AND public.subscription_member_allowed($1,m.id,$3)))`, orgID, storeID, now, userID).Scan(&allowed); err != nil {
		return statusErr(503, "服务暂不可用", "internal")
	}
	if !allowed {
		return statusErr(402, "店铺服务期已结束或不在本期保留名单中，历史数据仍可查看", "SUBSCRIPTION_STORE_PAUSED")
	}
	return nil
}
