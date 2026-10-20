package storerepo

import (
	"context"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// SellerProbe is the one Seller round trip a credential test or registration
// needs: POST /v1/roles. The egress already refuses a non-loopback base, so a
// deployment without a relay answers exactly as an unreachable Seller does.
type SellerProbe interface {
	// Roles posts /v1/roles and returns the raw status and body. A transport
	// failure comes back as status 0.
	Roles(ctx context.Context, clientID, apiKey string) (status int, body []byte, err error)
}

// credentialWriter is the transaction-bound half of key custody. It carries the
// key ring because a rosterTx is handed only a transaction, and the ring is a
// property of the process, not of the request.
type credentialWriter struct {
	ring  seal.Ring
	keyID string
}

// RegisterCredential is POST /api/workspaces/stores/{uuid}/credential's write
// phase. The probe already ran; this only decides and persists.
func (w credentialWriter) RegisterCredential(ctx context.Context, tx pgx.Tx, orgID int64, actor domain.Actor, uuid, clientID, apiKey string, expectedStoreRevision int64, expectedCredentialRevision *int64, expiresAtMS *int64) (domain.RegisterOutcome, *contract.APIError) {
	store, api := loadStoreCiphertext(ctx, tx, orgID, uuid)
	if api != nil {
		return domain.RegisterOutcome{}, api
	}
	if api := domain.EnsureCanManageKey(actor, store.asRow()); api != nil {
		return domain.RegisterOutcome{}, api
	}
	if api := domain.EnsureCredentialRevision(store.Revision, expectedStoreRevision); api != nil {
		return domain.RegisterOutcome{}, api
	}
	if store.ManualDisabled {
		return domain.RegisterOutcome{}, contract.Forbidden(contract.MsgStoreDisabled)
	}
	if store.QuotaSuspended {
		return domain.RegisterOutcome{}, contract.QuotaExhausted()
	}
	if api := ensureClientIDAvailable(ctx, tx, orgID, &clientID, &store.UUID); api != nil {
		return domain.RegisterOutcome{}, api
	}
	existing, api := loadExistingCredential(ctx, tx, store.StoreID, store.CredentialRevision)
	if api != nil {
		return domain.RegisterOutcome{}, api
	}
	samePair := existing != nil && fingerprintMatches(existing.Fingerprint, clientID, apiKey, w.ring.Primary)
	outcome, api := domain.PlanRegister(store.asRow(), existing, samePair, expectedCredentialRevision, clientID)
	if api != nil {
		return domain.RegisterOutcome{}, api
	}
	outcome.StoreUUID = store.UUID
	if !outcome.FingerprintChanged {
		// An idempotent re-register writes nothing, so the generations stay
		// where they were and the quota revision does not move.
		return outcome, nil
	}
	binding := credentialBinding{
		OrgID: orgID, StoreID: store.StoreID, CredentialRevision: outcome.CredentialRevision,
	}
	sealed, api := sealCredential(w.ring, w.keyID, binding, clientID, apiKey)
	if api != nil {
		return domain.RegisterOutcome{}, api
	}
	nowMS := domain.NowMS()
	if api := persistCredential(ctx, tx, store.StoreID, orgID, outcome.CredentialRevision, actor.UserID, sealed, outcome.Rotated, nowMS); api != nil {
		return domain.RegisterOutcome{}, api
	}
	if expiresAtMS != nil {
		if err := setKeyExpiry(ctx, tx, store.StoreID, outcome.CredentialRevision, *expiresAtMS); err != nil {
			return domain.RegisterOutcome{}, asAPIError(err, contract.MsgUnavailable)
		}
	}
	// Registering proves the key, so the operator's own row is a verification
	// of the generation that was just written.
	if api := upsertVerification(ctx, tx, store.UUID, actor.UserID, outcome.CredentialRevision, true, "", nowMS); api != nil {
		return domain.RegisterOutcome{}, api
	}
	if api := applyCredentialIdentity(ctx, tx, store.StoreID, expectedStoreRevision, outcome.CredentialRevision, outcome.Revision, clientID); api != nil {
		return domain.RegisterOutcome{}, api
	}
	return outcome, nil
}

// DeleteCredential is DELETE /api/workspaces/stores/{uuid}/credential's write
// phase: purge the ciphertext and advance the generation.
func (w credentialWriter) DeleteCredential(ctx context.Context, tx pgx.Tx, orgID int64, actor domain.Actor, uuid string, expectedStoreRevision, expectedCredentialRevision int64) (int64, *contract.APIError) {
	store, api := loadStoreCiphertext(ctx, tx, orgID, uuid)
	if api != nil {
		return 0, api
	}
	if api := domain.EnsureCanManageKey(actor, store.asRow()); api != nil {
		return 0, api
	}
	if api := domain.EnsureCredentialRevision(store.Revision, expectedStoreRevision); api != nil {
		return 0, api
	}
	existing, api := loadExistingCredential(ctx, tx, store.StoreID, store.CredentialRevision)
	if api != nil {
		return 0, api
	}
	if existing == nil {
		return 0, contract.Conflict(contract.MsgKeyNotRegistered)
	}
	if existing.CredentialRevision != expectedCredentialRevision {
		return 0, contract.Conflict(contract.MsgKeyGenStale)
	}
	return purgeCredential(ctx, tx, store, expectedStoreRevision)
}

// VerifyCredential records one probe's answer against the generation it
// probed. A rotation in between answers "test again", not a stale result.
func (w credentialWriter) VerifyCredential(ctx context.Context, tx pgx.Tx, orgID int64, actor domain.Actor, uuid string, credentialRevision int64, verified bool, failureCode string, expiresAtMS *int64) (domain.VerificationSummary, *contract.APIError) {
	store, api := loadStoreCiphertext(ctx, tx, orgID, uuid)
	if api != nil {
		return domain.VerificationSummary{}, api
	}
	if api := domain.EnsureCanTestKey(actor, store.asRow()); api != nil {
		return domain.VerificationSummary{}, api
	}
	nowMS := domain.NowMS()
	if api := domain.EnsureTestable(store.asRow(), nowMS); api != nil {
		return domain.VerificationSummary{}, api
	}
	if store.CredentialRevision != credentialRevision {
		return domain.VerificationSummary{}, contract.Conflict(contract.MsgKeyChangedRetest)
	}
	code, api := domain.VerificationResult(verified, failureCode)
	if api != nil {
		return domain.VerificationSummary{}, api
	}
	if api := upsertVerification(ctx, tx, store.UUID, actor.UserID, credentialRevision, verified, code, nowMS); api != nil {
		return domain.VerificationSummary{}, api
	}
	if verified && expiresAtMS != nil {
		if err := setKeyExpiry(ctx, tx, store.StoreID, credentialRevision, *expiresAtMS); err != nil {
			return domain.VerificationSummary{}, asAPIError(err, contract.MsgUnavailable)
		}
	}
	return loadVerificationSummary(ctx, tx, orgID, store.StoreID, credentialRevision)
}

// OpenCurrentCredential opens the store's current generation for a probe. It
// runs in its own tenant transaction; the caller already authorized the store.
func (r Repo) OpenCurrentCredential(ctx context.Context, orgID int64, uuid string) (domain.OpenedCredential, *contract.APIError) {
	if len(r.ring.Primary) != 32 {
		return domain.OpenedCredential{}, contract.MsgKeyCrypto()
	}
	var out domain.OpenedCredential
	var api *contract.APIError
	err := r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		store, apiErr := loadStoreCiphertext(ctx, tx, orgID, uuid)
		if apiErr != nil {
			api = apiErr
			return nil
		}
		if store.ManualDisabled {
			api = contract.Forbidden(contract.MsgStoreDisabled)
			return nil
		}
		if store.QuotaSuspended {
			api = contract.QuotaExhausted()
			return nil
		}
		var keyID *string
		var version *int
		var nonce, ciphertext, wrapped, dekNonce, fingerprint []byte
		var expires *int64
		var storedClientID *string
		scan := tx.QueryRow(ctx, `
			SELECT key_id, envelope_version, client_id, nonce, ciphertext,
			       wrapped_dek, dek_nonce, key_fingerprint, key_expires_at_ms
			  FROM public.store_seller_credentials
			 WHERE store_id = $1 AND credential_revision = $2
			 LIMIT 1`, store.StoreID, store.CredentialRevision).Scan(
			&keyID, &version, &storedClientID, &nonce, &ciphertext,
			&wrapped, &dekNonce, &fingerprint, &expires)
		if errors.Is(scan, pgx.ErrNoRows) {
			api = contract.Conflict(contract.MsgKeyNotRegistered)
			return nil
		}
		if scan != nil {
			api = asAPIError(scan, contract.MsgUnavailable)
			return nil
		}
		if expires != nil && *expires <= domain.NowMS() {
			api = contract.CredentialExpired(contract.MsgKeyExpired)
			return nil
		}
		versionNumber := 1
		if version != nil {
			versionNumber = *version
		}
		binding := credentialBinding{
			OrgID: orgID, StoreID: store.StoreID, CredentialRevision: store.CredentialRevision,
		}
		clientID, apiKey, apiErr := openCredential(r.ring, derefString(keyID), binding,
			versionNumber, storedClientID, nonce, ciphertext, wrapped, dekNonce, fingerprint)
		if apiErr != nil {
			api = apiErr
			return nil
		}
		out = domain.OpenedCredential{
			StoreID:            store.StoreID,
			UUID:               store.UUID,
			ClientID:           clientID,
			APIKey:             apiKey,
			CredentialRevision: store.CredentialRevision,
			KeyExpiresAtMS:     expires,
		}
		return nil
	})
	if err != nil && api == nil {
		api = asAPIError(err, contract.MsgUnavailable)
	}
	if api != nil {
		return domain.OpenedCredential{}, api
	}
	return out, nil
}

// MarkLeased records a probe against the generation. Best effort: the probe
// already ran, and a missed lease stamp must not surface as a failure.
func (r Repo) MarkLeased(ctx context.Context, orgID, storeID, credentialRevision, nowMS int64) {
	if err := r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		return markCredentialLeased(ctx, tx, storeID, credentialRevision, nowMS)
	}); err != nil {
		slog.Warn("credential lease stamp failed", "store_id", storeID, "err", err.Error())
	}
}

// Export opens every generation the actor may manage inside one tenant
// transaction. Plaintext leaves the process only through this response.
func (r Repo) Export(ctx context.Context, orgID int64, actor domain.Actor) ([]domain.ExportedCredential, *contract.APIError) {
	if len(r.ring.Primary) != 32 {
		return nil, contract.MsgKeyCrypto()
	}
	var out []domain.ExportedCredential
	var api *contract.APIError
	err := r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		rows, apiErr := exportRows(ctx, tx, orgID)
		if apiErr != nil {
			api = apiErr
			return nil
		}
		for _, row := range rows {
			if !actor.MayManageKey(row.AssigneeKeyManage, row.AssigneeMembership) {
				continue
			}
			binding := credentialBinding{
				OrgID: orgID, StoreID: row.StoreID, CredentialRevision: row.CredentialRevision,
			}
			clientID, apiKey, apiErr := openCredential(r.ring, row.KeyID, binding, row.Version,
				row.ClientID, row.Nonce, row.Ciphertext, row.WrappedDEK, row.DEKNonce, row.Fingerprint)
			if apiErr != nil {
				api = apiErr
				return nil
			}
			out = append(out, domain.ExportedCredential{
				UUID: row.UUID, Name: row.Name, ClientID: clientID, APIKey: apiKey,
			})
		}
		return nil
	})
	if err != nil && api == nil {
		api = asAPIError(err, contract.MsgUnavailable)
	}
	if api != nil {
		return nil, api
	}
	return out, nil
}

// CredentialGrants lists the stores the refresh loops should spend a Seller
// read on: visible, testable, and not already fresh.
func (r Repo) CredentialGrants(ctx context.Context, orgID int64, actor domain.Actor, nowMS int64, fresh func(domain.Row) bool) ([]domain.Row, *contract.APIError) {
	rows, api := r.ListRows(ctx, orgID, actor)
	if api != nil {
		return nil, api
	}
	out := make([]domain.Row, 0, len(rows))
	for _, row := range rows {
		if !row.Permissions(actor, nowMS).TestKey {
			continue
		}
		if fresh != nil && fresh(row) {
			continue
		}
		out = append(out, row)
	}
	return out, nil
}

// PersistSnapshot writes one JSON snapshot column on the generation that
// produced it. The WHERE clause pins the generation, so a value read under the
// old key can never land on the new one.
func (r Repo) PersistSnapshot(ctx context.Context, orgID, storeID, credentialRevision int64, column string, payload []byte) error {
	switch column {
	case "product_quota", "finance_balance":
	default:
		return errors.New("unknown snapshot column")
	}
	return r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE public.organization_stores SET `+column+` = $3::jsonb
			  WHERE id = $1 AND credential_revision = $2 AND deleted_at_ms IS NULL`,
			storeID, credentialRevision, string(payload))
		return err
	})
}

// ProbeRoles posts /v1/roles through the configured probe. A deployment with
// no probe is an unreachable Seller, which the caller reports as 502.
func (r Repo) ProbeRoles(ctx context.Context, clientID, apiKey string) (int, []byte, error) {
	if r.probe == nil {
		return 0, nil, ErrNoEgress
	}
	return r.probe.Roles(ctx, clientID, apiKey)
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
