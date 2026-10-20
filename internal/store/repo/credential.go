package storerepo

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// The credential envelope this build writes: version 2 only. A fresh DEK is
// drawn per generation, the payload is sealed under it, and the KEK only wraps
// that DEK. Both AADs bind the tenant, the store row, and the generation, so a
// ciphertext moved to another store or replayed onto a superseded revision
// fails to open.
const (
	envelopeVersion = 2
	dekLen          = 32
	wrappedDEKLen   = dekLen + 16
	nonceLen        = 12
)

// credentialBinding is the row identity the envelope is bound to.
type credentialBinding struct {
	OrgID              int64
	StoreID            int64
	CredentialRevision int64
}

// payloadAAD is store::credential::CredentialBinding::aad.
func (b credentialBinding) payloadAAD() string {
	return fmt.Sprintf("store_seller_credential|v1|%d|%d|%d", b.OrgID, b.StoreID, b.CredentialRevision)
}

// wrapAAD is store::credential_envelope::wrap_aad.
func (b credentialBinding) wrapAAD(keyID string) string {
	return fmt.Sprintf("store_seller_dek|v2|%d|%d|%s", b.OrgID, b.StoreID, keyID)
}

// sealedCredential is one row's worth of ciphertext.
type sealedCredential struct {
	KeyID       string
	Nonce       []byte
	Ciphertext  []byte
	WrappedDEK  []byte
	DEKNonce    []byte
	Fingerprint []byte
}

// sealCredential draws a DEK and seals under it. The KEK never touches the
// payload; it only wraps the DEK.
func sealCredential(kek seal.Ring, keyID string, binding credentialBinding, clientID, apiKey string) (sealedCredential, *contract.APIError) {
	if len(kek.Primary) != 32 {
		return sealedCredential{}, &contract.APIError{
			Status: 503, Code: contract.CodeInternal, Message: contract.MsgKeyCryptoMissing,
		}
	}
	dek := make([]byte, dekLen)
	if _, err := rand.Read(dek); err != nil {
		return sealedCredential{}, contract.Internal()
	}
	defer zero(dek)
	dekNonce := make([]byte, nonceLen)
	if _, err := rand.Read(dekNonce); err != nil {
		return sealedCredential{}, contract.Internal()
	}
	wrapped, err := gcmSeal(kek.Primary, dekNonce, dek, []byte(binding.wrapAAD(keyID)))
	if err != nil {
		return sealedCredential{}, contract.Internal()
	}
	if len(wrapped) != wrappedDEKLen {
		return sealedCredential{}, contract.Internal()
	}
	nonce := make([]byte, nonceLen)
	if _, err := rand.Read(nonce); err != nil {
		return sealedCredential{}, contract.Internal()
	}
	payload := make([]byte, 0, len(clientID)+1+len(apiKey))
	payload = append(payload, clientID...)
	payload = append(payload, 0)
	payload = append(payload, apiKey...)
	defer zero(payload)
	ciphertext, err := gcmSeal(dek, nonce, payload, []byte(binding.payloadAAD()))
	if err != nil {
		return sealedCredential{}, contract.Internal()
	}
	return sealedCredential{
		KeyID:       keyID,
		Nonce:       nonce,
		Ciphertext:  ciphertext,
		WrappedDEK:  wrapped,
		DEKNonce:    dekNonce,
		Fingerprint: credentialFingerprint(kek.Primary, clientID, apiKey),
	}, nil
}

// openCredential opens a stored v1 or v2 row. A row stamped with the current
// key id tries only the current KEK; any other stamp tries current, then
// previous, so a label-only rotation still opens.
func openCredential(ring seal.Ring, keyID string, binding credentialBinding, version int, clientID *string, nonce, ciphertext, wrapped, dekNonce, fingerprint []byte) (string, string, *contract.APIError) {
	crypto := &contract.APIError{Status: 503, Code: contract.CodeInternal, Message: contract.MsgKeyCryptoMissing}
	if len(ring.Primary) != 32 {
		return "", "", crypto
	}
	keys := [][]byte{ring.Primary}
	if keyID != currentCredentialKeyID() && len(ring.Previous) == 32 {
		keys = append(keys, ring.Previous)
	}
	var last error = seal.ErrEnvelope
	for _, kek := range keys {
		var openedID, openedKey string
		var err error
		if version == 1 {
			openedID = ""
			if clientID != nil {
				openedID = *clientID
			}
			var plain []byte
			plain, err = gcmOpen(kek, nonce, ciphertext, []byte(binding.payloadAAD()))
			if err == nil {
				openedKey = string(plain)
			}
		} else {
			openedID, openedKey, err = openEnvelope(kek, keyID, binding, nonce, ciphertext, wrapped, dekNonce)
		}
		if err == nil {
			if !fingerprintMatches(fingerprint, openedID, openedKey, ring.Primary) {
				last = seal.ErrEnvelope
				continue
			}
			return openedID, openedKey, nil
		}
		last = err
	}
	_ = last
	return "", "", crypto
}

func openEnvelope(kek []byte, keyID string, binding credentialBinding, nonce, ciphertext, wrapped, dekNonce []byte) (string, string, error) {
	if len(wrapped) != wrappedDEKLen || len(dekNonce) != nonceLen {
		return "", "", seal.ErrEnvelope
	}
	dek, err := gcmOpen(kek, dekNonce, wrapped, []byte(binding.wrapAAD(keyID)))
	if err != nil || len(dek) != dekLen {
		return "", "", seal.ErrEnvelope
	}
	defer zero(dek)
	plain, err := gcmOpen(dek, nonce, ciphertext, []byte(binding.payloadAAD()))
	if err != nil {
		return "", "", seal.ErrEnvelope
	}
	i := bytes.IndexByte(plain, 0)
	if i < 0 {
		return "", "", seal.ErrEnvelope
	}
	return string(plain[:i]), string(plain[i+1:]), nil
}

func gcmSeal(key, nonce, plain, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Seal(nil, nonce, plain, aad), nil
}

func gcmOpen(key, nonce, ciphertext, aad []byte) ([]byte, error) {
	if len(nonce) != nonceLen {
		return nil, seal.ErrEnvelope
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, ciphertext, aad)
}

// credentialFingerprint is HMAC-SHA256(HMAC-SHA256(KEK, info), plaintext). It
// decides whether a registration is the same pair; it is never stored in the
// clear and never returned.
func credentialFingerprint(kek []byte, clientID, apiKey string) []byte {
	return seal.Fingerprint(kek, clientID, apiKey)
}

func fingerprintMatches(stored []byte, clientID, apiKey string, kek []byte) bool {
	if len(stored) != sha256.Size {
		return false
	}
	return bytes.Equal(stored, credentialFingerprint(kek, clientID, apiKey))
}

func zero(value []byte) {
	for i := range value {
		value[i] = 0
	}
}

// CredentialKeyID is the key id this process stamps. It is contract with the
// rewrap tooling, so it comes from the same place the roster does.
func currentCredentialKeyID() string { return CredentialKeyID }

// CredentialKeyID is set by the assembly layer from config. It stays a package
// variable here because the repo is constructed before the key id is known on
// every path, and archtest forbids business code reading the environment.
var CredentialKeyID = seal.DefaultSellerKeyID

// StoreCiphertext is the narrow row the credential writers read under lock.
type StoreCiphertext struct {
	StoreID            int64
	OrgID              int64
	UUID               string
	ClientID           *string
	CredentialRevision int64
	Revision           int64
	ManualDisabled     bool
	QuotaSuspended     bool
	AssigneeMembership *int64
	AssigneeKeyManage  bool
}

// loadStoreCiphertext is credential_store::load_store: the row the credential
// writers lock before deciding, plus the tombstone sentence.
func loadStoreCiphertext(ctx context.Context, tx pgx.Tx, orgID int64, uuid string) (StoreCiphertext, *contract.APIError) {
	var out StoreCiphertext
	var deleted *int64
	err := tx.QueryRow(ctx, `
		SELECT s.id, s.org_id, lower(s.uuid::text), s.client_id, s.credential_revision,
		       s.revision, s.manual_disabled, s.quota_suspended,
		       s.assignee_membership_id, s.assignee_key_manage, s.deleted_at_ms
		  FROM public.organization_stores s
		 WHERE s.org_id = $1 AND s.uuid = $2::uuid
		 LIMIT 1
		 FOR UPDATE`, orgID, uuid).Scan(
		&out.StoreID, &out.OrgID, &out.UUID, &out.ClientID, &out.CredentialRevision,
		&out.Revision, &out.ManualDisabled, &out.QuotaSuspended,
		&out.AssigneeMembership, &out.AssigneeKeyManage, &deleted)
	if errors.Is(err, pgx.ErrNoRows) {
		return StoreCiphertext{}, contract.NotFound(contract.MsgStoreMissing)
	}
	if err != nil {
		return StoreCiphertext{}, asAPIError(err, contract.MsgUnavailable)
	}
	if deleted != nil {
		return StoreCiphertext{}, contract.NotFound(contract.MsgStoreDeleted)
	}
	return out, nil
}

// asRow is the permission-check view of the same row.
func (s StoreCiphertext) asRow() domain.Row {
	return domain.Row{
		ID:                   s.StoreID,
		UUID:                 s.UUID,
		ClientID:             s.ClientID,
		ManualDisabled:       s.ManualDisabled,
		QuotaSuspended:       s.QuotaSuspended,
		CredentialRevision:   s.CredentialRevision,
		AssigneeMembershipID: s.AssigneeMembership,
		AssigneeKeyManage:    s.AssigneeKeyManage,
		Revision:             s.Revision,
	}
}

// loadExistingCredential reads the current generation's ciphertext row under
// lock. A row for a superseded generation is not "existing": the store has no
// usable key.
func loadExistingCredential(ctx context.Context, tx pgx.Tx, storeID, revision int64) (*domain.ExistingCredential, *contract.APIError) {
	var out domain.ExistingCredential
	err := tx.QueryRow(ctx, `
		SELECT credential_revision, key_fingerprint
		  FROM public.store_seller_credentials
		 WHERE store_id = $1 AND credential_revision = $2
		 LIMIT 1
		 FOR UPDATE`, storeID, revision).Scan(&out.CredentialRevision, &out.Fingerprint)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, asAPIError(err, contract.MsgUnavailable)
	}
	return &out, nil
}

// persistCredential writes or replaces the store's ciphertext row. One row per
// store: the superseded generation is overwritten, which is what makes the
// AAD's revision binding meaningful.
func persistCredential(ctx context.Context, tx pgx.Tx, storeID, orgID, credentialRevision, userID int64, sealed sealedCredential, rotate bool, nowMS int64) *contract.APIError {
	var rotated *int64
	if rotate {
		rotated = &nowMS
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO public.store_seller_credentials (
		       store_id, org_id, credential_revision, client_id, key_id, nonce,
		       ciphertext, key_fingerprint, registered_by_user_id,
		       registered_at_ms, rotated_at_ms, wrapped_dek, dek_nonce,
		       envelope_version)
		VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (store_id) DO UPDATE SET
		       org_id = EXCLUDED.org_id,
		       credential_revision = EXCLUDED.credential_revision,
		       client_id = NULL,
		       key_id = EXCLUDED.key_id,
		       nonce = EXCLUDED.nonce,
		       ciphertext = EXCLUDED.ciphertext,
		       key_fingerprint = EXCLUDED.key_fingerprint,
		       wrapped_dek = EXCLUDED.wrapped_dek,
		       dek_nonce = EXCLUDED.dek_nonce,
		       envelope_version = EXCLUDED.envelope_version,
		       rotated_at_ms = EXCLUDED.rotated_at_ms,
		       key_expires_at_ms = NULL,
		       updated_at = clock_timestamp()`,
		storeID, orgID, credentialRevision, sealed.KeyID, sealed.Nonce,
		sealed.Ciphertext, sealed.Fingerprint, userID, nowMS, rotated,
		sealed.WrappedDEK, sealed.DEKNonce, envelopeVersion)
	if err != nil {
		return asAPIError(err, contract.MsgUnavailable)
	}
	return nil
}

// applyCredentialIdentity writes the roster half of a registration: the Client
// ID, the new generation, and — because both snapshots belong to the old key —
// drops the product quota and finance balance.
func applyCredentialIdentity(ctx context.Context, tx pgx.Tx, storeID, expectedRevision, credentialRevision, nextRevision int64, clientID string) *contract.APIError {
	tag, err := tx.Exec(ctx, `
		UPDATE public.organization_stores
		   SET client_id = $1,
		       credential_revision = $2,
		       revision = $3,
		       product_quota = NULL,
		       finance_balance = NULL,
		       updated_at = clock_timestamp()
		 WHERE id = $4 AND revision = $5 AND deleted_at_ms IS NULL`,
		clientID, credentialRevision, nextRevision, storeID, expectedRevision)
	if err != nil {
		return asAPIError(err, contract.MsgUnavailable)
	}
	// Unreachable while the row lock holds, but persisting the ciphertext has
	// already overwritten the only row by the time this runs; a silent miss
	// would strand the new generation behind a roster that never advanced.
	if tag.RowsAffected() != 1 {
		return contract.Conflict(contract.MsgRevisionChanged)
	}
	return nil
}

// purgeCredential drops the ciphertext and advances the roster generation.
func purgeCredential(ctx context.Context, tx pgx.Tx, store StoreCiphertext, expectedStoreRevision int64) (int64, *contract.APIError) {
	if _, err := tx.Exec(ctx,
		`DELETE FROM public.store_seller_credentials WHERE store_id = $1`, store.StoreID); err != nil {
		return 0, asAPIError(err, contract.MsgUnavailable)
	}
	nextRevision := store.Revision + 1
	nextCredentialRevision := store.CredentialRevision + 1
	tag, err := tx.Exec(ctx, `
		UPDATE public.organization_stores
		   SET credential_revision = $1,
		       revision = revision + 1,
		       product_quota = NULL,
		       finance_balance = NULL,
		       updated_at = clock_timestamp()
		 WHERE id = $2 AND revision = $3 AND deleted_at_ms IS NULL`,
		nextCredentialRevision, store.StoreID, expectedStoreRevision)
	if err != nil {
		return 0, asAPIError(err, contract.MsgUnavailable)
	}
	if tag.RowsAffected() != 1 {
		return 0, contract.Conflict(contract.MsgRevisionChanged)
	}
	return nextRevision, nil
}

// markCredentialLeased records the newest lease on the current generation. A
// failure here is logged by the caller, not surfaced: the probe already ran.
func markCredentialLeased(ctx context.Context, tx pgx.Tx, storeID, credentialRevision, nowMS int64) error {
	_, err := tx.Exec(ctx, `
		UPDATE public.store_seller_credentials
		   SET last_leased_at_ms = greatest(coalesce(last_leased_at_ms, 0), $3)
		 WHERE store_id = $1 AND credential_revision = $2`,
		storeID, credentialRevision, nowMS)
	return err
}

// setKeyExpiry stamps the key's own expiry on the generation that produced it.
func setKeyExpiry(ctx context.Context, tx pgx.Tx, storeID, credentialRevision, expiresAtMS int64) error {
	_, err := tx.Exec(ctx, `
		UPDATE public.store_seller_credentials
		   SET key_expires_at_ms = $3, updated_at = clock_timestamp()
		 WHERE store_id = $1 AND credential_revision = $2`,
		storeID, credentialRevision, expiresAtMS)
	return err
}

// upsertVerification records one operator's result for one generation. The CTE
// repeats the active/revision predicate under the row lock, so a rotation that
// commits first cannot be verified by a stale claim.
func upsertVerification(ctx context.Context, tx pgx.Tx, storeUUID string, userID, credentialRevision int64, verified bool, failureCode string, nowMS int64) *contract.APIError {
	var code *string
	if failureCode != "" {
		code = &failureCode
	}
	tag, err := tx.Exec(ctx, `
		WITH active_store AS (
		    SELECT id, org_id
		      FROM public.organization_stores
		     WHERE uuid = $1::uuid
		       AND deleted_at_ms IS NULL
		       AND NOT manual_disabled
		       AND NOT quota_suspended
		       AND credential_revision = $3
		     FOR UPDATE)
		INSERT INTO public.store_credential_verifications
		       (org_id, store_id, user_id, credential_revision, verified, verified_at_ms, failure_code)
		SELECT org_id, id, $2, $3, $4, $6, $5
		  FROM active_store
		ON CONFLICT (org_id, store_id, user_id, credential_revision)
		DO UPDATE SET verified = EXCLUDED.verified,
		              verified_at_ms = EXCLUDED.verified_at_ms,
		              failure_code = EXCLUDED.failure_code,
		              updated_at = clock_timestamp()`,
		storeUUID, userID, credentialRevision, verified, code, nowMS)
	if err != nil {
		return asAPIError(err, contract.MsgUnavailable)
	}
	if tag.RowsAffected() != 1 {
		return contract.Conflict(contract.MsgVerifyStateChanged)
	}
	return nil
}

// loadVerificationSummary tallies the current generation's successful rows.
func loadVerificationSummary(ctx context.Context, tx pgx.Tx, orgID, storeID, credentialRevision int64) (domain.VerificationSummary, *contract.APIError) {
	var out domain.VerificationSummary
	err := tx.QueryRow(ctx, `
		SELECT COUNT(*) FILTER (WHERE verified)::bigint,
		       MAX(verified_at_ms) FILTER (WHERE verified)
		  FROM public.store_credential_verifications
		 WHERE org_id = $1 AND store_id = $2 AND credential_revision = $3`,
		orgID, storeID, credentialRevision).Scan(&out.VerifiedOperators, &out.LatestVerifiedAtMS)
	if err != nil {
		return domain.VerificationSummary{}, asAPIError(err, contract.MsgUnavailable)
	}
	return out, nil
}

// exportRows reads every live store the actor may manage keys for. The
// visibility and grant rules are applied in memory because they depend on the
// actor, not on the row.
func exportRows(ctx context.Context, tx pgx.Tx, orgID int64) ([]exportRow, *contract.APIError) {
	rows, err := tx.Query(ctx, `
		SELECT s.id, lower(s.uuid::text), s.name, s.credential_revision,
		       s.assignee_membership_id, s.assignee_key_manage,
		       c.client_id, c.key_id, c.envelope_version, c.nonce, c.ciphertext,
		       c.wrapped_dek, c.dek_nonce, c.key_fingerprint
		  FROM public.organization_stores s
		  JOIN public.store_seller_credentials c
		    ON c.store_id = s.id AND c.credential_revision = s.credential_revision
		 WHERE s.org_id = $1 AND s.deleted_at_ms IS NULL
		 ORDER BY s.create_order`, orgID)
	if err != nil {
		return nil, asAPIError(err, contract.MsgUnavailable)
	}
	defer rows.Close()
	var out []exportRow
	for rows.Next() {
		var row exportRow
		if err := rows.Scan(&row.StoreID, &row.UUID, &row.Name, &row.CredentialRevision,
			&row.AssigneeMembership, &row.AssigneeKeyManage,
			&row.ClientID, &row.KeyID, &row.Version, &row.Nonce, &row.Ciphertext,
			&row.WrappedDEK, &row.DEKNonce, &row.Fingerprint); err != nil {
			return nil, asAPIError(err, contract.MsgUnavailable)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, asAPIError(err, contract.MsgUnavailable)
	}
	return out, nil
}

type exportRow struct {
	StoreID            int64
	UUID               string
	Name               string
	CredentialRevision int64
	AssigneeMembership *int64
	AssigneeKeyManage  bool
	ClientID           *string
	KeyID              string
	Version            int
	Nonce              []byte
	Ciphertext         []byte
	WrappedDEK         []byte
	DEKNonce           []byte
	Fingerprint        []byte
}

// jsonOrNil renders a nullable extra for the audit payload.
func jsonOrNil(value any) any {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return json.RawMessage(raw)
}
