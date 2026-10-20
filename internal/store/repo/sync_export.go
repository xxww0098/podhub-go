package storerepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/jobsched"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// The transaction-bound surface the sync runner spends. The runner lives in
// store/jobs, which may reach this unit's contract and domain but not its
// internals, so every phase gets one exported entry point here.

// ErrCredentialExpired marks a stored key past its expiry: the runner parks
// the row on the credential hold instead of sending a request.
var ErrCredentialExpired = errors.New("seller credential expired")

// LoadSyncSnapshotTx is the runner's phase-one read. `locked` takes the row
// FOR UPDATE.
func LoadSyncSnapshotTx(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID string, nowMS int64, locked bool) (*domain.SyncSnapshot, error) {
	return loadSyncSnapshot(ctx, tx, orgID, storeUUID, nowMS, locked)
}

// OpenCredentialTx opens the store's current generation inside the reserve
// transaction, so an expired key never sends. A generation Ozon cannot validate
// is not a Seller failure and lands no incident.
func OpenCredentialTx(ctx context.Context, tx pgx.Tx, ring seal.Ring, keyID string, state domain.SyncSnapshot, nowMS int64) (domain.OpenedCredential, error) {
	if len(ring.Primary) != 32 {
		return domain.OpenedCredential{}, errors.New("credential key ring is not configured")
	}
	var storedKeyID *string
	var version *int
	var nonce, ciphertext, wrapped, dekNonce, fingerprint []byte
	var expires *int64
	var clientID *string
	err := tx.QueryRow(ctx, `
		SELECT key_id, envelope_version, client_id, nonce, ciphertext,
		       wrapped_dek, dek_nonce, key_fingerprint, key_expires_at_ms
		  FROM public.store_seller_credentials
		 WHERE store_id = $1 AND credential_revision = $2
		 LIMIT 1`, state.StorePK, state.CredentialRevision).Scan(
		&storedKeyID, &version, &clientID, &nonce, &ciphertext,
		&wrapped, &dekNonce, &fingerprint, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.OpenedCredential{}, errors.New("no credential generation")
	}
	if err != nil {
		return domain.OpenedCredential{}, err
	}
	if expires != nil && *expires <= nowMS {
		return domain.OpenedCredential{}, ErrCredentialExpired
	}
	versionNumber := 1
	if version != nil {
		versionNumber = *version
	}
	binding := credentialBinding{
		OrgID: state.OrgID, StoreID: state.StorePK, CredentialRevision: state.CredentialRevision,
	}
	openedID, openedKey, api := openCredential(ring, derefString(storedKeyID), binding,
		versionNumber, clientID, nonce, ciphertext, wrapped, dekNonce, fingerprint)
	if api != nil {
		return domain.OpenedCredential{}, errors.New(api.Message)
	}
	return domain.OpenedCredential{
		StoreID:            state.StorePK,
		UUID:               state.StoreUUID,
		ClientID:           openedID,
		APIKey:             openedKey,
		CredentialRevision: state.CredentialRevision,
		KeyExpiresAtMS:     expires,
	}, nil
}

// VoidSyncGenerationTx clears a dead generation's progress. The reserve path
// has taken no lease yet, so this is the unfenced form — exactly as the
// decision kernel's own void write is.
func VoidSyncGenerationTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, nextDueMS int64) error {
	_, err := tx.Exec(ctx, `
		UPDATE public.store_product_sync
		   SET pass = 'none', cursor_last_id = NULL,
		       generation_started_at_ms = NULL,
		       hold_reason = 'generation_expired', next_due_at_ms = $3
		 WHERE store_id = $1::uuid AND org_id = $2`,
		state.StoreUUID, state.OrgID, nextDueMS)
	return err
}

// voidStagingLostTx is the finalize path's void: the row is under this
// request's lease, so the write carries the full fence.
func voidStagingLostTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, token string, nextDueMS int64) error {
	return voidSyncGeneration(ctx, tx, state, token, nextDueMS)
}

// LandSyncHoldTx is the one writer of the hold axis.
func LandSyncHoldTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, hold string, untilMS *int64, reason string) error {
	return landSyncHold(ctx, tx, state, hold, untilMS, reason)
}

// PendingDetailPageTx is the lowest undetailed live staging page.
func PendingDetailPageTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot) (int32, []int64, bool, error) {
	return pendingDetailPage(ctx, tx, state)
}

// SpendSyncCallTx books one Seller call before it leaves.
func SpendSyncCallTx(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID string, purpose domain.SyncPurpose, dayKey string) error {
	return spendSyncCall(ctx, tx, orgID, storeUUID, purpose, dayKey)
}

// ClaimSyncLeaseTx writes the inflight lease after the charge.
func ClaimSyncLeaseTx(ctx context.Context, tx pgx.Tx, storeUUID string, orgID int64, token string, untilMS int64) error {
	return claimSyncLease(ctx, tx, storeUUID, orgID, token, untilMS)
}

// ClearSyncLeaseTx drops this token's lease.
func ClearSyncLeaseTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, token string) (bool, error) {
	return clearSyncLease(ctx, tx, state, token)
}

// RefundSyncCallTx gives a charge back on the day it landed.
func RefundSyncCallTx(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID string, purpose domain.SyncPurpose, dayKey string) error {
	return refundSyncCall(ctx, tx, orgID, storeUUID, purpose, dayKey)
}

// StageSyncListingTx mirrors one listing page's ids.
func StageSyncListingTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, archived bool, productIDs []int64, offerIDs []string) error {
	return stageSyncListing(ctx, tx, state, archived, productIDs, offerIDs)
}

// LandSyncPassTx advances the pass behind the fence.
func LandSyncPassTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, token, pass string, cursor *string, pageNo int32, archived bool, productIDs []int64, nowMS int64) (bool, error) {
	return landSyncPass(ctx, tx, state, token, pass, cursor, pageNo, archived, productIDs, nowMS)
}

// LandSyncDetailTx writes one chunk's answers and stamps the page read.
func LandSyncDetailTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, token string, pageNo int32, products []domain.SellerProduct, unanswered []int64, nowMS int64) (bool, error) {
	return landSyncDetail(ctx, tx, state, token, pageNo, products, unanswered, nowMS)
}

// StagingCountsTx compares the persisted page counters with the staging table.
func StagingCountsTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot) (int64, int64, error) {
	return stagingCounts(ctx, tx, state)
}

// MarkGoneSyncProductsTx publishes what the generation did not see.
func MarkGoneSyncProductsTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, nowMS int64) error {
	return markGoneSyncProducts(ctx, tx, state, nowMS)
}

// CommitSyncGenerationTx is the whole-or-nothing commit behind the fence.
func CommitSyncGenerationTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, token string, nowMS, nextDueMS int64) (bool, error) {
	return commitSyncGeneration(ctx, tx, state, token, nowMS, nextDueMS)
}

// LandSyncMetricsTx writes one funnel page and its stamps.
func LandSyncMetricsTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, outcome domain.SyncMetricsOutcome, stamp domain.FxStamp, nowMS int64) error {
	return landSyncMetrics(ctx, tx, state, outcome, stamp, nowMS)
}

// DropStagingPagesTx deletes a committed generation's witness pages.
func DropStagingPagesTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot) error {
	return dropStagingPages(ctx, tx, state)
}

// RecordSyncFailureTx lands one refusal on the row.
func RecordSyncFailureTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, token string, landing domain.FailureLanding, nowMS int64) error {
	return recordSyncFailure(ctx, tx, state, token, landing, nowMS)
}

// RecordSyncIncidentTx appends one pressure or egress signal.
func RecordSyncIncidentTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, clientID, path, origin string, status int, nowMS int64) error {
	return recordIncident(ctx, tx, state.OrgID, state.StoreUUID, clientID, origin, path, status, nowMS)
}

// StoreCurrencyTx reads the store-level contract currency.
func StoreCurrencyTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot) (*string, error) {
	return storeCurrencyValue(ctx, tx, state)
}

// SettleJobTx moves this Job to a terminal state inside the caller's
// transaction, behind the same lease fence the standalone settle uses.
func SettleJobTx(ctx context.Context, tx pgx.Tx, lease jobsched.Lease, terminal string, result []byte) error {
	tag, err := tx.Exec(ctx, `
		UPDATE public.jobs
		   SET state = $4,
		       result_ref = CASE WHEN $5::jsonb IS NULL THEN result_ref ELSE $5::jsonb END,
		       lease_owner = NULL,
		       lease_until = NULL,
		       updated_at = clock_timestamp()
		 WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3 AND state = 'running'`,
		lease.ID, lease.Owner, lease.Epoch, terminal, result)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		// The lease was lost; the successor owns the row now.
		return nil
	}
	_, err = tx.Exec(ctx, `SELECT public.release_execution_permit('job', $1, $2)`,
		lease.ID.String(), lease.Epoch)
	return err
}

// DueSyncRow is one due store the reconcile sweep wakes.
type DueSyncRow struct {
	StoreUUID           string
	OrgID               int64
	SubmitterUserID     int64
	NextDueMS           *int64
	ManualRequestedAtMS *int64
	LastFullSyncAtMS    *int64
	Pass                *string
}

// MaterializeSyncRowsTx enters stores into the mirror lazily: a registered,
// unexpired key is the admission. A disabled or suspended store keeps its
// mirror readable but is never woken.
//
// The slot phase is computed here, not in SQL: it is FNV-1a over the store
// uuid and must match the Go ledger's own phase, because a store's reconcile
// slot is derived from the same number on both sides.
func MaterializeSyncRowsTx(ctx context.Context, tx pgx.Tx, nowMS int64) error {
	rows, err := tx.Query(ctx, `
		SELECT s.org_id, s.uuid::text
		  FROM public.organization_stores s
		 WHERE s.deleted_at_ms IS NULL
		   AND NOT s.manual_disabled
		   AND NOT s.quota_suspended
		   AND EXISTS (SELECT 1 FROM public.store_seller_credentials c
		                WHERE c.store_id = s.id
		                  AND c.credential_revision = s.credential_revision
		                  AND (c.key_expires_at_ms IS NULL OR c.key_expires_at_ms > $1))
		   AND NOT EXISTS (SELECT 1 FROM public.store_product_sync p
		                    WHERE p.store_id = s.uuid)
		 ORDER BY s.id
		 LIMIT 32`, nowMS)
	if err != nil {
		return err
	}
	type missing struct {
		orgID int64
		uuid  string
	}
	var found []missing
	for rows.Next() {
		var row missing
		if err := rows.Scan(&row.orgID, &row.uuid); err != nil {
			rows.Close()
			return err
		}
		found = append(found, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, row := range found {
		if _, err := tx.Exec(ctx, `
			INSERT INTO public.store_product_sync
			       (org_id, store_id, refresh_generation, pass, next_due_at_ms)
			VALUES ($1, $2::uuid, 1, 'none', $3)
			ON CONFLICT (store_id) DO NOTHING`,
			row.orgID, row.uuid, domain.NextReconcileSlot(nowMS, row.uuid)); err != nil {
			return err
		}
	}
	return nil
}

// DueSyncRowsTx finds the rows this tick may wake. One pending Job per
// Workspace is enough: queueing extras only burns claims.
func DueSyncRowsTx(ctx context.Context, tx pgx.Tx, nowMS int64, limit int) ([]DueSyncRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT p.store_id::text, p.org_id, o.owner_user_id, p.next_due_at_ms,
		       p.manual_requested_at_ms, p.last_full_sync_at_ms, p.pass
		  FROM public.store_product_sync p
		  JOIN public.organizations o ON o.id = p.org_id
		 WHERE p.next_due_at_ms IS NOT NULL
		   AND p.next_due_at_ms <= $1
		   AND o.dissolved_at IS NULL
		   AND o.owner_user_id > 0
		   AND NOT EXISTS (SELECT 1 FROM public.jobs j
		                    WHERE j.org_id = p.org_id
		                      AND j.kind = 'store.product_sync'
		                      AND j.state IN ('queued','retry_wait','running'))
		 ORDER BY p.next_due_at_ms
		 FOR UPDATE OF p SKIP LOCKED
		 LIMIT $2`, nowMS, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]DueSyncRow, 0, limit)
	for rows.Next() {
		var row DueSyncRow
		if err := rows.Scan(&row.StoreUUID, &row.OrgID, &row.SubmitterUserID, &row.NextDueMS,
			&row.ManualRequestedAtMS, &row.LastFullSyncAtMS, &row.Pass); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// SetSyncNextDueTx moves one store's next slot.
func SetSyncNextDueTx(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID string, nextDueMS int64) error {
	_, err := tx.Exec(ctx, `
		UPDATE public.store_product_sync SET next_due_at_ms = $3
		 WHERE store_id = $1::uuid AND org_id = $2`, storeUUID, orgID, nextDueMS)
	return err
}

// CleanupSyncRowsTx is the daily old-data sweep (data-model §7): gone products
// past thirty days, mirrors of stores soft-deleted past thirty days, pressure
// incidents past seven. Every statement is one set-based DELETE, safe to
// re-run.
func CleanupSyncRowsTx(ctx context.Context, tx pgx.Tx, nowMS int64) error {
	const day = int64(24 * 60 * 60 * 1000)
	statements := []struct {
		sql string
		arg int64
	}{
		{`DELETE FROM public.store_products
		   WHERE gone_at_ms IS NOT NULL AND gone_at_ms < $1`, nowMS - 30*day},
		{`DELETE FROM public.store_product_sync p
		   USING public.organization_stores s
		   WHERE s.uuid = p.store_id AND s.org_id = p.org_id
		     AND s.deleted_at_ms IS NOT NULL AND s.deleted_at_ms < $1`, nowMS - 30*day},
		{`DELETE FROM public.store_products p
		   USING public.organization_stores s
		   WHERE s.id = p.store_pk AND s.org_id = p.org_id
		     AND s.deleted_at_ms IS NOT NULL AND s.deleted_at_ms < $1`, nowMS - 30*day},
		{`DELETE FROM public.seller_read_incidents WHERE at_ms < $1`, nowMS - 7*day},
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.sql, statement.arg); err != nil {
			return err
		}
	}
	return nil
}
