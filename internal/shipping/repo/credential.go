package repo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/shipping/contract"
)

// shopSecret is the unsealed Client-Id and Api-Key for one dial.
type shopSecret struct {
	ClientID string
	APIKey   string
}

// openCred loads the store row and opens its current credential.
// A missing store is the same 404 as a missing injection.
// Expired and missing-key sentences are the ones the credential port uses.
// Anything else that is not a database error is the catch-all 502.
func (r Repo) openCred(ctx context.Context, orgID int64, storeUUID string, now int64) (shopSecret, error) {
	if r.Pool == nil {
		return shopSecret{}, contract.Internal("")
	}
	var (
		deleted                   *int64
		expires                   *int64
		version                   *int
		clientID, keyID           *string
		nonce, ciphertext         []byte
		wrapped, dekNonce, finger []byte
	)
	err := r.Pool.QueryRow(ctx, `
		SELECT s.deleted_at_ms, c.key_expires_at_ms, c.envelope_version, c.client_id, c.key_id,
		       c.nonce, c.ciphertext, c.wrapped_dek, c.dek_nonce, c.key_fingerprint
		FROM organization_stores s
		LEFT JOIN store_seller_credentials c ON c.store_id = s.id
		WHERE s.org_id = $1 AND s.uuid = $2::uuid
		LIMIT 1`, orgID, storeUUID).Scan(
		&deleted, &expires, &version, &clientID, &keyID, &nonce, &ciphertext, &wrapped, &dekNonce, &finger)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && deleted != nil) {
		return shopSecret{}, contract.NotFound("记录不存在")
	}
	if err != nil {
		return shopSecret{}, mapDB(err)
	}
	if expires != nil && *expires <= now {
		return shopSecret{}, contract.Conflict("Seller 密钥已过期，请在卖家后台重新生成后登记")
	}
	if keyID == nil || len(nonce) == 0 || len(ciphertext) == 0 {
		return shopSecret{}, contract.Validation("Store 尚未登记密钥")
	}
	if !r.KeyReady {
		return shopSecret{}, contract.Gateway("店铺密钥不可用")
	}
	env := seal.Store{KeyID: *keyID, Nonce: nonce, Ciphertext: ciphertext, WrappedDEK: wrapped, DEKNonce: dekNonce, Fingerprint: finger}
	if version != nil {
		env.Version = *version
	}
	if clientID != nil {
		env.ClientID = *clientID
	}
	secret, err := r.Ring.OpenStore(env)
	if err != nil {
		return shopSecret{}, contract.Gateway("店铺密钥不可用")
	}
	return shopSecret{ClientID: secret.ClientID, APIKey: secret.APIKey}, nil
}
