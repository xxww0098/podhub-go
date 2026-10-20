package storerepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// UpsertProductsTx is the one write path for product facts. The content hash
// gates the UPDATE arm, so a row whose business values did not change is not
// written at all.
func UpsertProductsTx(ctx context.Context, tx pgx.Tx, orgID, storePK int64, storeUUID string, products []domain.SellerProduct, nowMS int64) *contract.APIError {
	for _, product := range products {
		if product.ID <= 0 {
			continue
		}
		facts := product.Facts()
		statusID, err := ensureStatusID(ctx, tx, facts.IsArchived,
			facts.StatusTexts.Status, facts.StatusTexts.StatusName,
			facts.StatusTexts.ModerateStatus, facts.StatusTexts.ValidationStatus)
		if err != nil {
			return asAPIError(err, contract.MsgUnavailable)
		}
		hash := facts.ContentHash(statusID)
		if _, err := tx.Exec(ctx, `
			INSERT INTO public.store_products
			       (org_id, store_pk, product_id, offer_id, sku, name, status_id,
			        price, old_price, stock_present, stock_reserved, primary_image,
			        content_hash, refreshed_at_ms, gone_at_ms,
			        model_id, model_count, description_category_id, type_id)
			VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), $7,
			        NULLIF($8, '')::numeric, NULLIF($9, '')::numeric,
			        $10, $11, NULLIF($12, ''),
			        $13, $14, NULL,
			        $15, $16, $17, $18)
			ON CONFLICT (store_pk, product_id) DO UPDATE SET
			       offer_id = COALESCE(NULLIF($4, ''), public.store_products.offer_id),
			       sku = $5,
			       name = NULLIF($6, ''),
			       status_id = $7,
			       price = COALESCE(NULLIF($8, '')::numeric, public.store_products.price),
			       old_price = COALESCE(NULLIF($9, '')::numeric, public.store_products.old_price),
			       stock_present = COALESCE($10, public.store_products.stock_present),
			       stock_reserved = COALESCE($11, public.store_products.stock_reserved),
			       primary_image = NULLIF($12, ''),
			       model_id = COALESCE($15, public.store_products.model_id),
			       model_count = COALESCE($16, public.store_products.model_count),
			       description_category_id =
			           COALESCE($17, public.store_products.description_category_id),
			       type_id = COALESCE($18, public.store_products.type_id),
			       content_hash = $13,
			       refreshed_at_ms = $14,
			       gone_at_ms = NULL
			 WHERE public.store_products.content_hash IS DISTINCT FROM $13`,
			orgID, storePK, facts.ProductID, facts.OfferID, facts.SKU, facts.Name, statusID,
			facts.Price, facts.OldPrice, facts.StockPresent, facts.StockReserved, facts.PrimaryImage,
			hash, nowMS, facts.ModelID, facts.ModelCount, facts.DescriptionCategory, facts.TypeID); err != nil {
			return asAPIError(err, contract.MsgUnavailable)
		}
		if facts.Currency != "" {
			if api := persistStoreCurrency(ctx, tx, orgID, storeUUID, facts.Currency); api != nil {
				return api
			}
		}
	}
	return nil
}

// persistStoreCurrency records the store-level currency (one per account, not
// per row). A later disagreement keeps the stored value: the first sight is
// the fact, later ones are Ozon echoing a stale field.
func persistStoreCurrency(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID, currency string) *contract.APIError {
	var stored *string
	err := tx.QueryRow(ctx, `
		SELECT currency FROM public.store_product_sync
		 WHERE store_id = $1::uuid AND org_id = $2`, storeUUID, orgID).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) {
		// No sync row yet — the scheduler materializes one.
		return nil
	}
	if err != nil {
		return asAPIError(err, contract.MsgUnavailable)
	}
	if stored != nil && *stored == currency {
		return nil
	}
	if _, err := tx.Exec(ctx, `
		UPDATE public.store_product_sync SET currency = $3
		 WHERE store_id = $1::uuid AND org_id = $2 AND currency IS DISTINCT FROM $3`,
		storeUUID, orgID, currency); err != nil {
		return asAPIError(err, contract.MsgUnavailable)
	}
	return nil
}

// SyncNowTx is POST …/products/sync inside the caller's write transaction. It
// answers the press, or refuses with the moment the interval lifts.
func SyncNowTx(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID string, nowMS int64, syncDisabled bool) (domain.SyncPress, *contract.APIError) {
	if syncDisabled {
		return domain.SyncPress{}, contract.Cooldown(contract.MsgSyncDisabled)
	}
	var storePK int64
	var manualDisabled, quotaSuspended bool
	var keyExpires *int64
	err := tx.QueryRow(ctx, `
		SELECT s.id, s.manual_disabled, s.quota_suspended,
		       (SELECT c.key_expires_at_ms FROM public.store_seller_credentials c
		         WHERE c.store_id = s.id AND c.credential_revision = s.credential_revision)
		  FROM public.organization_stores s
		 WHERE s.uuid = $1::uuid AND s.org_id = $2 AND s.deleted_at_ms IS NULL
		 FOR UPDATE`, storeUUID, orgID).Scan(&storePK, &manualDisabled, &quotaSuspended, &keyExpires)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.SyncPress{}, contract.NotFound(contract.MsgProductStoreMiss)
	}
	if err != nil {
		return domain.SyncPress{}, asAPIError(err, contract.MsgUnavailable)
	}
	if manualDisabled || quotaSuspended {
		return domain.SyncPress{}, contract.Cooldown(contract.MsgStoreOff)
	}
	if keyExpires != nil && *keyExpires <= nowMS {
		return domain.SyncPress{}, contract.CredentialExpired(contract.MsgVerifyExpiredShort)
	}
	if api := ensureSyncRow(ctx, tx, orgID, storeUUID); api != nil {
		return domain.SyncPress{}, api
	}
	state, api := loadSyncState(ctx, tx, orgID, storeUUID, true)
	if api != nil {
		return domain.SyncPress{}, api
	}
	// An open hold refuses with its window: Ozon already limited this
	// Client-Id, and the page shows the countdown instead of retrying.
	if state.Hold != nil && *state.Hold != "none" &&
		state.HoldUntilMS != nil && *state.HoldUntilMS > nowMS {
		holdErr := contract.Cooldown(contract.MsgSyncHold)
		holdErr.WithExtra("retryAfterMs", *state.HoldUntilMS-nowMS)
		holdErr.WithExtra("untilMs", *state.HoldUntilMS)
		return domain.SyncPress{}, holdErr
	}
	breakers, err := readBreakers(ctx, tx, orgID, nowMS)
	if err != nil {
		return domain.SyncPress{}, asAPIError(err, contract.MsgUnavailable)
	}
	if breakers.WorkspaceOpen || breakers.DeploymentOpen {
		breakerErr := contract.Cooldown(contract.MsgSyncBreaker)
		breakerErr.WithExtra("untilMs", nowMS)
		return domain.SyncPress{}, breakerErr
	}
	inflight := state.InflightUntilMS != nil && *state.InflightUntilMS > nowMS
	press, tooSoon, nextAllowed := domain.PlanManualPress(
		derefString(state.Pass), &state.RefreshGeneration, state.ManualRequestedAtMS,
		inflight, state.Pending, nowMS)
	if tooSoon {
		tooSoonErr := &contract.APIError{
			Status: 429, Code: contract.CodeManualTooSoon, Message: contract.MsgSyncTooSoon,
		}
		tooSoonErr.WithExtra("manualNextAllowedAtMs", nextAllowed)
		tooSoonErr.WithExtra("retryAfterMs", nextAllowed-nowMS)
		return domain.SyncPress{}, tooSoonErr
	}
	var nextDue *int64
	if !press.Attached {
		nextDue = &nowMS
	}
	if api := stampManualPress(ctx, tx, orgID, storeUUID, nowMS, nextDue); api != nil {
		return domain.SyncPress{}, api
	}
	return press, nil
}

// VerifyClaim is what the first verify transaction answers.
type VerifyClaim struct {
	// Rows is set when the same batch was claimed inside the window: the
	// answer comes from the mirror with no Seller call.
	Rows []domain.Product
	// Won means this request owns the call.
	Won bool
	// StorePK and CredentialRevision identify the generation to land under.
	StorePK            int64
	CredentialRevision int64
}

// ClaimVerifyTx runs availability, the sync row, the dedup CAS, and the gates
// in one short transaction. Committing the stamp before the call is what makes
// a concurrent same-batch verify answer from the mirror.
func ClaimVerifyTx(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID, digest string, nowMS int64, syncDisabled bool) (VerifyClaim, *contract.APIError) {
	if syncDisabled {
		return VerifyClaim{}, contract.Cooldown(contract.MsgSyncDisabled)
	}
	var storePK int64
	var manualDisabled, quotaSuspended bool
	var credentialRevision int64
	err := tx.QueryRow(ctx, `
		SELECT id, manual_disabled, quota_suspended, credential_revision
		  FROM public.organization_stores
		 WHERE uuid = $1::uuid AND org_id = $2 AND deleted_at_ms IS NULL`,
		storeUUID, orgID).Scan(&storePK, &manualDisabled, &quotaSuspended, &credentialRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return VerifyClaim{}, contract.NotFound(contract.MsgProductStoreMiss)
	}
	if err != nil {
		return VerifyClaim{}, asAPIError(err, contract.MsgUnavailable)
	}
	if manualDisabled || quotaSuspended {
		return VerifyClaim{}, contract.Cooldown(contract.MsgStoreOff)
	}
	if api := ensureSyncRow(ctx, tx, orgID, storeUUID); api != nil {
		return VerifyClaim{}, api
	}
	won, api := claimVerify(ctx, tx, orgID, storeUUID, digest, nowMS)
	if api != nil {
		return VerifyClaim{}, api
	}
	if !won {
		return VerifyClaim{Rows: []domain.Product{}}, nil
	}
	state, api := loadSyncState(ctx, tx, orgID, storeUUID, false)
	if api != nil {
		return VerifyClaim{}, api
	}
	if state.Hold != nil && *state.Hold != "none" &&
		state.HoldUntilMS != nil && *state.HoldUntilMS > nowMS {
		return VerifyClaim{}, contract.Cooldown(contract.MsgSyncHold)
	}
	breakers, err := readBreakers(ctx, tx, orgID, nowMS)
	if err != nil {
		return VerifyClaim{}, asAPIError(err, contract.MsgUnavailable)
	}
	if breakers.WorkspaceOpen || breakers.DeploymentOpen {
		return VerifyClaim{}, contract.Cooldown(contract.MsgSyncBreaker)
	}
	return VerifyClaim{Won: true, StorePK: storePK, CredentialRevision: credentialRevision}, nil
}

// RecordVerifyIncidentTx writes one pressure signal in its own statement, so a
// failed insert can never abort the caller's work. Only Ozon's own backpressure
// counts: a 4xx about the request says nothing about the fleet.
func RecordVerifyIncidentTx(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID, clientID string, status int, nowMS int64) {
	if status != 429 && status < 500 {
		return
	}
	_ = recordIncident(ctx, tx, orgID, storeUUID, clientID, "/v3/product/info/list", "product_verify", status, nowMS)
}

// ReleaseVerifyTx undoes this request's own dedup stamp after a failed call.
func ReleaseVerifyTx(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID, digest string, nowMS int64) {
	releaseVerify(ctx, tx, orgID, storeUUID, digest, nowMS)
}
