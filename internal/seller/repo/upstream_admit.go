package sellerrepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/seller/contract"
)

// AdmitStore opens one store credential for the upstream proxy.
type AdmitStore struct {
	Pool     *pgxpool.Pool
	Ring     seal.Ring
	KeyReady bool
}

// NewAdmitStore keeps the pool and the key ring. A nil pool fails closed.
func NewAdmitStore(pool *pgxpool.Pool, ring seal.Ring, keyReady bool) AdmitStore {
	return AdmitStore{Pool: pool, Ring: ring, KeyReady: keyReady}
}

const admitSQL = `
SELECT s.id, s.deleted_at_ms, s.manual_disabled, s.quota_suspended, s.assignee_membership_id,
       m.id, m.status, m.manual_disabled, m.quota_suspended,
       c.key_expires_at_ms, c.envelope_version, c.client_id, c.key_id,
       c.nonce, c.ciphertext, c.wrapped_dek, c.dek_nonce, c.key_fingerprint
FROM organization_stores s
LEFT JOIN organization_members m ON m.org_id = s.org_id AND m.user_id = $3
LEFT JOIN store_seller_credentials c ON c.store_id = s.id
WHERE s.org_id = $1 AND s.uuid = $2::uuid
LIMIT 1`

// Admit implements the proxy admission order. Visibility fails as 404
// before a disabled or suspended store can confirm that the row exists.
func (s AdmitStore) Admit(ctx context.Context, orgID, userID int64, role, storeUUID string, nowMS int64) (string, string, error) {
	if s.Pool == nil {
		return "", "", contract.InternalAdmit()
	}
	var (
		id                        int64
		deleted                   *int64
		storeManual, storeQuota   bool
		assignee                  *int64
		member                    *int64
		memberStatus              *string
		memberManual, memberQuota *bool
		expires                   *int64
		version                   *int
		clientID, keyID           *string
		nonce, ciphertext         []byte
		wrapped, dekNonce, finger []byte
	)
	err := s.Pool.QueryRow(ctx, admitSQL, orgID, storeUUID, userID).Scan(
		&id, &deleted, &storeManual, &storeQuota, &assignee,
		&member, &memberStatus, &memberManual, &memberQuota,
		&expires, &version, &clientID, &keyID, &nonce, &ciphertext, &wrapped, &dekNonce, &finger,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", contract.MissingStore()
	}
	if err != nil {
		return "", "", mapAdmit(err)
	}
	if deleted != nil || member == nil {
		return "", "", contract.MissingStore()
	}
	unavailable := memberStatus == nil || *memberStatus != "active"
	if memberManual != nil && *memberManual {
		unavailable = true
	}
	if memberQuota != nil && *memberQuota {
		unavailable = true
	}
	if unavailable {
		return "", "", &contract.AdmitError{Status: 403, Code: "FORBIDDEN", Message: "工作空间成员当前不可用"}
	}
	if !access.CanManage(role) && (assignee == nil || *assignee != *member) {
		return "", "", contract.MissingStore()
	}
	if storeManual {
		return "", "", &contract.AdmitError{Status: 403, Code: "FORBIDDEN", Message: "店铺已停用，无法使用"}
	}
	if storeQuota {
		return "", "", &contract.AdmitError{Status: 409, Code: "QUOTA_EXHAUSTED", Message: "店铺配额已挂起，无法使用"}
	}
	if expires != nil && *expires <= nowMS {
		return "", "", &contract.AdmitError{Status: 409, Code: "CREDENTIAL_EXPIRED", Message: "Seller 密钥已过期，请在卖家后台重新生成后登记"}
	}
	if keyID == nil || len(nonce) == 0 || len(ciphertext) == 0 {
		return "", "", &contract.AdmitError{Status: 409, Code: "CONFLICT", Message: "Store 尚未登记密钥"}
	}
	if !s.KeyReady {
		return "", "", &contract.AdmitError{Status: 503, Code: "INTERNAL", Message: "Seller 密钥托管未配置"}
	}
	env := seal.Store{KeyID: *keyID, Nonce: nonce, Ciphertext: ciphertext, WrappedDEK: wrapped, DEKNonce: dekNonce, Fingerprint: finger}
	if version != nil {
		env.Version = *version
	}
	if clientID != nil {
		env.ClientID = *clientID
	}
	secret, err := s.Ring.OpenStore(env)
	if err != nil {
		return "", "", contract.InternalAdmit()
	}
	return secret.ClientID, secret.APIKey, nil
}

func mapAdmit(err error) error {
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		switch pe.Code {
		case "55P03":
			return &contract.AdmitError{Status: 503, Code: "INTERNAL", Message: "资源正在更新，请稍后重试", RetryAfter: 1}
		case "P0M01":
			return &contract.AdmitError{Status: 409, Code: "INTERNAL", Message: "媒体对象已进入回收，请重新上传"}
		case "22P02":
			return contract.MissingStore()
		}
	}
	return contract.InternalAdmit()
}
