package mcprepo

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/mcp/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

// ListingState reads only the exact row in a store visible to the grant owner.
func (r *Repo) ListingState(ctx context.Context, grant domain.Grant, claim domain.Claim, cardID, rowID, storeID string) (json.RawMessage, error) {
	if grant.ScopeKind != "workspace" || !grant.Permits("read") {
		return nil, denied()
	}
	var result json.RawMessage
	err := r.inTx(ctx, db.App(grant.OrgID), func(tx pgx.Tx) error {
		if err := scopeGrant(ctx, tx, grant.ID); err != nil {
			return internal()
		}
		live, err := resolveByID(ctx, tx, grant.ID, true)
		if err != nil {
			return internal()
		}
		if live == nil || live.UserID != grant.UserID || live.OrgID != grant.OrgID || !live.Permits("read") {
			return denied()
		}
		if err := fence(ctx, tx, claim, 1); err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `
			SELECT jsonb_build_object(
			  'rowId', r.id::text, 'cardId', r.card_id::text, 'storeId', r.store_id::text,
			  'revision', r.revision, 'contentState', r.content_state, 'mediaState', r.media_state,
			  'validationState', r.validation_state, 'submissionState', r.submission_state,
			  'source', r.payload->'source', 'intent', (
			    SELECT jsonb_build_object('id', i.id::text, 'state', i.state,
			      'taskId', i.external_task_id, 'errorCode', i.last_error_code,
			      'importStatus', i.reconciliation_outcome->'importTask'->>'status',
			      'productId', i.reconciliation_outcome->'found'->'productId')
			    FROM submission_intents i
			    WHERE i.org_id=r.org_id AND i.listing_row_id=r.id AND i.store_id=s.uuid
			    ORDER BY i.row_revision DESC, i.created_at DESC, i.id DESC LIMIT 1))
			FROM listing_rows r
			JOIN organization_stores s ON s.org_id=r.org_id AND s.uuid=r.store_id AND s.deleted_at_ms IS NULL
			JOIN organization_members m ON m.org_id=r.org_id AND m.user_id=$5
			  AND m.status='active' AND NOT m.manual_disabled AND NOT m.quota_suspended
			WHERE r.org_id=$1 AND r.card_id=$2::uuid AND r.id=$3::uuid AND s.uuid=$4::uuid
			  AND (m.role IN ('owner','manager') OR s.assignee_membership_id=m.id)`,
			grant.OrgID, cardID, rowID, storeID, grant.UserID).Scan(&result)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.NewHost("domain_error", "Requested listing data is unavailable; check permissions and filters")
		}
		if err != nil {
			return internal()
		}
		return nil
	})
	return result, err
}
