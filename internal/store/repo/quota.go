package storerepo

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// reconcileStoreQuota resolves the Workspace's effective Store limit and
// reconciles every live Store against it. Every Store and plan writer goes
// through here, so the effective-limit formula has one owner.
func reconcileStoreQuota(ctx context.Context, tx pgx.Tx, orgID int64) (domain.QuotaChanges, error) {
	limit, apiErr := loadStoreLimit(ctx, tx, orgID)
	if apiErr != nil {
		return domain.QuotaChanges{}, apiErr
	}
	return reconcileStoreQuotaWithLimit(ctx, tx, orgID, limit)
}

// reconcileStoreQuotaWithLimit applies a caller-proposed limit. Only the admin
// seat writer passes one, and only because it just persisted that exact limit.
func reconcileStoreQuotaWithLimit(ctx context.Context, tx pgx.Tx, orgID, limit int64) (domain.QuotaChanges, error) {
	if limit < domain.MinStoreLimit {
		limit = domain.MinStoreLimit
	}
	rows, err := listReconcileRows(ctx, tx, orgID)
	if err != nil {
		return domain.QuotaChanges{}, err
	}
	plan := domain.PlanStoreQuotaReconcile(rows, limit)
	if err := applyQuotaSuspended(ctx, tx, plan.Suspend, true); err != nil {
		return domain.QuotaChanges{}, err
	}
	if err := applyQuotaSuspended(ctx, tx, plan.Restore, false); err != nil {
		return domain.QuotaChanges{}, err
	}
	return domain.QuotaChanges{Suspend: plan.Suspend, Restore: plan.Restore}.Ensure(), nil
}

// listReconcileRows reads the rows the planner ranks. The credential lease is
// the recency fact, so a store that has actually run recently keeps its slot.
func listReconcileRows(ctx context.Context, tx pgx.Tx, orgID int64) ([]domain.ReconcileRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT s.id, lower(s.uuid::text), s.create_order,
		       s.manual_disabled, s.quota_suspended,
		       c.last_leased_at_ms
		  FROM public.organization_stores s
		  LEFT JOIN public.store_seller_credentials c
		         ON c.store_id = s.id AND c.credential_revision = s.credential_revision
		 WHERE s.org_id = $1 AND s.deleted_at_ms IS NULL
		 ORDER BY COALESCE(c.last_leased_at_ms, 0) DESC, s.create_order ASC, s.id ASC
		 FOR UPDATE OF s`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.ReconcileRow, 0)
	for rows.Next() {
		var row domain.ReconcileRow
		if err := rows.Scan(&row.ID, &row.UUID, &row.CreateOrder,
			&row.ManualDisabled, &row.QuotaSuspended, &row.LastUsedMS); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// applyQuotaSuspended flips quota_suspended for a planned set in one statement.
// The IS DISTINCT FROM guard keeps revision from advancing on stores that
// already hold the target state, so a no-op reconcile stays revision-stable.
func applyQuotaSuspended(ctx context.Context, tx pgx.Tx, changes []domain.QuotaChange, suspended bool) error {
	if len(changes) == 0 {
		return nil
	}
	uuids := make([]string, 0, len(changes))
	for _, change := range changes {
		uuids = append(uuids, change.UUID)
	}
	_, err := tx.Exec(ctx, `
		UPDATE public.organization_stores
		   SET quota_suspended = $1,
		       revision = revision + 1,
		       updated_at = clock_timestamp()
		 WHERE uuid = ANY($2::uuid[])
		   AND deleted_at_ms IS NULL
		   AND quota_suspended IS DISTINCT FROM $1`, suspended, uuids)
	return err
}
