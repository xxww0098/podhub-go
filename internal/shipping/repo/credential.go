package repo

import (
	"context"
	"crypto/hmac"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/db"
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
		storeID, revision         int64
		deleted                   *int64
		expires                   *int64
		version                   *int
		clientID, keyID           *string
		nonce, ciphertext         []byte
		wrapped, dekNonce, finger []byte
	)
	err := db.InTx(ctx, r.Pool, db.App(orgID), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
		SELECT s.id, s.credential_revision, s.deleted_at_ms, c.key_expires_at_ms, c.envelope_version, c.client_id, c.key_id,
		       c.nonce, c.ciphertext, c.wrapped_dek, c.dek_nonce, c.key_fingerprint
		FROM organization_stores s
		LEFT JOIN store_seller_credentials c ON c.store_id = s.id AND c.org_id = s.org_id
		    AND c.credential_revision = s.credential_revision
		WHERE s.org_id = $1 AND s.uuid = $2::uuid
		LIMIT 1`, orgID, storeUUID).Scan(
			&storeID, &revision, &deleted, &expires, &version, &clientID, &keyID, &nonce, &ciphertext, &wrapped, &dekNonce, &finger)
	})
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
	currentKeyID := r.KeyID
	if currentKeyID == "" {
		currentKeyID = seal.DefaultSellerKeyID
	}
	keys := [][]byte{r.Ring.Primary}
	if *keyID != currentKeyID && len(r.Ring.Previous) == 32 {
		keys = append(keys, r.Ring.Previous)
	}
	for _, key := range keys {
		var openedID, openedKey string
		if version == nil || *version == 1 {
			var plain []byte
			plain, err = seal.OpenBlob(key, seal.StoreAAD(orgID, storeID, revision), nonce, ciphertext)
			if clientID != nil {
				openedID = *clientID
			}
			openedKey = string(plain)
		} else if *version == 2 {
			openedID, openedKey, err = seal.OpenV2(key, seal.StoreAAD(orgID, storeID, revision),
				seal.WrapAAD(orgID, storeID, *keyID), nonce, ciphertext, dekNonce, wrapped)
		} else {
			return shopSecret{}, contract.Gateway("店铺密钥不可用")
		}
		if err == nil && openedID != "" && openedKey != "" && hmac.Equal(finger, seal.Fingerprint(r.Ring.Primary, openedID, openedKey)) {
			return shopSecret{ClientID: openedID, APIKey: openedKey}, nil
		}
	}
	return shopSecret{}, contract.Gateway("店铺密钥不可用")
}
