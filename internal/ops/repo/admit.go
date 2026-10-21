package repo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
	"github.com/xxww0098/podhub-go/internal/platform/seal"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

const admitSQL = `
SELECT s.id, s.deleted_at_ms, s.manual_disabled, (NOT public.subscription_store_allowed(s.org_id,s.uuid,to_timestamp($4::double precision/1000))),
       s.assignee_membership_id,
       m.id AS membership_id,
       c.credential_revision, c.key_expires_at_ms,
       c.envelope_version, c.client_id, c.key_id, c.nonce, c.ciphertext,
       c.wrapped_dek, c.dek_nonce, c.key_fingerprint
FROM organization_stores s
LEFT JOIN organization_members m
       ON m.org_id = s.org_id AND m.user_id = $3 AND m.status = 'active' AND NOT m.manual_disabled AND public.subscription_member_allowed(m.org_id,m.id,to_timestamp($4::double precision/1000))
LEFT JOIN store_seller_credentials c ON c.store_id = s.id
WHERE s.org_id = $1 AND s.uuid = $2::uuid
LIMIT 1`

// Admit loads one store. organization_stores has no RLS; the predicate is org_id.
func (s *Store) Admit(ctx context.Context, orgID, userID int64, role, storeID string, nowMS int64) (contract.Admitted, error) {
	if s == nil || s.Pool == nil {
		return contract.Admitted{}, contract.Internal("")
	}
	var (
		id            int64
		deleted       *int64
		manual, quota bool
		assignee      *int64
		member        *int64
		rev           *int64
		expires       *int64
		version       *int
		clientID      *string
		keyID         *string
		nonce         []byte
		ciphertext    []byte
		wrapped       []byte
		dekNonce      []byte
		finger        []byte
	)
	err := s.Pool.QueryRow(ctx, admitSQL, orgID, storeID, userID, nowMS).Scan(
		&id, &deleted, &manual, &quota, &assignee, &member,
		&rev, &expires, &version, &clientID, &keyID, &nonce, &ciphertext, &wrapped, &dekNonce, &finger,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return contract.Admitted{}, &contract.Fail{Status: 404, Code: contract.CodeNotFound, Message: contract.MsgStoreMissing}
	}
	if err != nil {
		return contract.Admitted{}, mapDB(err, true)
	}
	if deleted != nil {
		return contract.Admitted{}, &contract.Fail{Status: 404, Code: contract.CodeNotFound, Message: contract.MsgStoreMissing}
	}
	if member == nil {
		return contract.Admitted{}, contract.Forbidden(contract.MsgMemberUnavailable)
	}
	if !access.CanManage(role) && (assignee == nil || *assignee != *member) {
		return contract.Admitted{}, &contract.Fail{Status: 404, Code: contract.CodeNotFound, Message: contract.MsgStoreMissing}
	}
	if manual {
		return contract.Admitted{}, contract.Forbidden(contract.MsgStoreDisabled)
	}
	if quota {
		return contract.Admitted{}, &contract.Fail{Status: 409, Code: contract.CodeConflict, Message: contract.MsgQuotaSuspended}
	}
	if expires != nil && *expires <= nowMS {
		return contract.Admitted{}, &contract.Fail{Status: 409, Code: contract.CodeConflict, Message: contract.MsgKeyExpired}
	}
	if keyID == nil || nonce == nil || ciphertext == nil {
		return contract.Admitted{}, &contract.Fail{Status: 409, Code: contract.CodeConflict, Message: contract.MsgKeyMissing}
	}
	if !s.KeyReady {
		return contract.Admitted{}, &contract.Fail{Status: 503, Code: contract.CodeInternal, Message: contract.MsgKeyHostMissing}
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
		return contract.Admitted{}, contract.Internal("")
	}
	return contract.Admitted{StorePK: id, UUID: storeID, Secret: contract.Secret{ClientID: secret.ClientID, APIKey: secret.APIKey}}, nil
}
