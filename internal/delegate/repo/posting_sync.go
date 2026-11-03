package delegaterepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/delegate/domain"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// PostingCredential permits only a persisted unfinished order, even when new work is paused.
func (r Repo) PostingCredential(ctx context.Context, orgID int64, target contract.SyncTarget, nowMS int64) (contract.SealedCredential, error) {
	var cred contract.SealedCredential
	err := r.readTx(ctx, orgID, func(tx pgx.Tx) error {
		var expires *int64
		err := tx.QueryRow(ctx, `SELECT s.org_id,s.id,s.uuid::text,c.credential_revision,c.client_id,c.key_id,
		 c.nonce,c.ciphertext,c.wrapped_dek,c.dek_nonce,c.key_fingerprint,c.envelope_version,c.key_expires_at_ms
		 FROM delegate_orders o JOIN organization_stores s ON s.org_id=o.org_id AND s.uuid=o.store_id
		 JOIN store_seller_credentials c ON c.org_id=s.org_id AND c.store_id=s.id AND c.credential_revision=s.credential_revision
		 WHERE o.org_id=$1 AND o.order_id=$2::uuid AND o.store_id=$3::uuid AND o.posting_number=$4
		 AND o.state IN (`+openStates+`) AND s.deleted_at_ms IS NULL`, orgID, target.OrderID, target.StoreID, target.PostingNumber).Scan(
			&cred.OrgID, &cred.StorePK, &cred.StoreUUID, &cred.CredentialRevision, &cred.ClientID, &cred.KeyID,
			&cred.Nonce, &cred.Ciphertext, &cred.WrappedDEK, &cred.DEKNonce, &cred.KeyFingerprint, &cred.EnvelopeVersion, &expires)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.NotFound("委托单或当前店铺密钥不存在")
		}
		if err != nil {
			return err
		}
		if cred.KeyID == "" || len(cred.Ciphertext) == 0 || expires != nil && *expires <= nowMS {
			return contract.Conflict("Seller 密钥不可用或已过期，请重新登记")
		}
		return nil
	})
	return cred, err
}

func (r Repo) SyncTargets(ctx context.Context, orgID int64) ([]contract.SyncTarget, error) {
	out := []contract.SyncTarget{}
	err := r.readTx(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT order_id::text,store_id::text,posting_number,updated_at_ms
		 FROM delegate_orders WHERE org_id=$1 AND state IN (`+openStates+`) ORDER BY order_id`, orgID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var target contract.SyncTarget
			if err := rows.Scan(&target.OrderID, &target.StoreID, &target.PostingNumber, &target.UpdatedAtMS); err != nil {
				return err
			}
			out = append(out, target)
		}
		return rows.Err()
	})
	return out, err
}

// ApplyPostingOn runs inside the queue's epoch fence and the caller's tenant transaction.
func (r Repo) ApplyPostingOn(ctx context.Context, tx pgx.Tx, orgID, userID int64, target contract.SyncTarget, update contract.PostingUpdate, nowMS int64, auto bool) (bool, error) {
	defer writer.Forget(tx)
	if err := guardLease(ctx, tx, nowMS); err != nil {
		return false, err
	}
	if err := lockOrg(ctx, tx, orgID); err != nil {
		return false, err
	}
	var state string
	err := tx.QueryRow(ctx, `SELECT state FROM delegate_orders
	 WHERE org_id=$1 AND order_id=$2::uuid AND store_id=$3::uuid AND posting_number=$4
	 AND updated_at_ms=$5 AND state IN (`+openStates+`) FOR UPDATE`,
		orgID, target.OrderID, target.StoreID, target.PostingNumber, target.UpdatedAtMS).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	nowMS = max(nowMS, target.UpdatedAtMS+1)
	if _, err := tx.Exec(ctx, `UPDATE delegate_orders SET posting_snapshot=$3::jsonb,
	 logistics=COALESCE($4::jsonb,logistics),updated_at_ms=$5 WHERE org_id=$1 AND order_id=$2::uuid`,
		orgID, target.OrderID, update.Snapshot, update.Logistics, nowMS); err != nil {
		return false, err
	}
	switch update.Status {
	case "cancelled":
		var accepted int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM delegate_dispatches
		 WHERE org_id=$1 AND order_id=$2::uuid AND state IN ('accepted','shipped')`, orgID, target.OrderID).Scan(&accepted); err != nil {
			return false, err
		}
		edge, err := domain.AdminCancel(state, accepted)
		if err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `UPDATE delegate_orders SET state=$3,cancel_requested=cancel_requested OR $4
		 WHERE org_id=$1 AND order_id=$2::uuid`, orgID, target.OrderID, edge.State, edge.CancelRequested); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `UPDATE delegate_dispatches SET state='cancelled',updated_at_ms=$3
		 WHERE org_id=$1 AND order_id=$2::uuid AND state='dispatched'`, orgID, target.OrderID, nowMS); err != nil {
			return false, err
		}
		if edge.ReleaseHeld {
			if err := releaseHeld(ctx, tx, orgID, target.OrderID, nowMS); err != nil {
				return false, err
			}
		}
	case "delivered":
		if state == "shipped" {
			if _, err := tx.Exec(ctx, `UPDATE delegate_orders SET state='done' WHERE org_id=$1 AND order_id=$2::uuid`, orgID, target.OrderID); err != nil {
				return false, err
			}
		}
	default:
		if err := recompute(ctx, tx, target.OrderID, nowMS); err != nil {
			return false, err
		}
		if auto && (update.Status == "awaiting_packaging" || update.Status == "awaiting_deliver") {
			allowed, err := canAutoSync(ctx, tx, orgID, userID, target.StoreID, nowMS)
			if err != nil {
				return false, err
			}
			if allowed {
				if err := dispatchReady(ctx, tx, orgID, target.OrderID, nowMS); err != nil {
					return false, err
				}
			}
		}
	}
	if err := audit(ctx, tx, orgID, userID, "delegate_order", target.OrderID, "POST", "/v3/posting/fbs/get", "delegate_posting_synced", map[string]string{"posting_number": target.PostingNumber, "status": update.Status}); err != nil {
		return false, err
	}
	return true, nil
}

func canAutoSync(ctx context.Context, tx pgx.Tx, orgID, userID int64, storeID string, nowMS int64) (bool, error) {
	var allowed bool
	err := tx.QueryRow(ctx, `SELECT true FROM organization_stores s
	 JOIN organization_members m ON m.org_id=s.org_id AND m.user_id=$3
	 JOIN account_users u ON u.id=m.user_id AND u.disabled_at IS NULL
	 JOIN store_seller_credentials c ON c.store_id=s.id AND c.org_id=s.org_id AND c.credential_revision=s.credential_revision
	 WHERE s.org_id=$1 AND s.uuid=$2::uuid AND s.deleted_at_ms IS NULL AND NOT s.manual_disabled AND NOT s.quota_suspended
	 AND m.role IN ('owner','manager') AND m.status='active' AND NOT m.manual_disabled AND NOT m.quota_suspended
	 AND public.subscription_store_allowed($1,s.uuid,$4)
	 AND public.subscription_member_allowed($1,m.id,$4)
	 AND (c.key_expires_at_ms IS NULL OR c.key_expires_at_ms>$5)
	 FOR SHARE OF s,m,u,c`, orgID, storeID, userID, time.UnixMilli(nowMS), nowMS).Scan(&allowed)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return allowed, err
}
