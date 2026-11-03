package service

import (
	"context"
	"log/slog"
	"strings"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// CredentialDirectory is the repo side of key custody outside the write
// transaction: the read that opens a stored pair for a probe, the export, and
// the probe itself. The writers ride on RosterTx.
type CredentialDirectory interface {
	OpenCurrentCredential(ctx context.Context, orgID int64, actor domain.Actor, uuid string) (domain.OpenedCredential, *contract.APIError)
	Export(ctx context.Context, orgID int64, actor domain.Actor) ([]domain.ExportedCredential, *contract.APIError)
	ProbeRoles(ctx context.Context, clientID, apiKey string) (status int, body []byte, err error)
	MarkLeased(ctx context.Context, orgID, storeID, credentialRevision, nowMS int64)
}

// WithCredentialDirectory binds key custody.
func (s Service) WithCredentialDirectory(dir CredentialDirectory) Service {
	s.credential = dir
	return s
}

// ResolveCredentialName reads Seller info without changing the store or its key.
func (s Service) ResolveCredentialName(ctx context.Context, orgID, userID int64, storeUUID, clientID, apiKey string) (string, *contract.APIError) {
	if s.roster == nil || s.info == nil {
		return "", contract.Internal()
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return "", api
	}
	if strings.TrimSpace(apiKey) == "" && storeUUID != "" {
		uuid, ok := domain.NormalizeStoreUUID(storeUUID)
		if !ok {
			return "", contract.Validation(contract.MsgStoreUUID)
		}
		if s.credential == nil {
			return "", contract.Internal()
		}
		opened, api := s.credential.OpenCurrentCredential(ctx, orgID, actor, uuid)
		if api != nil {
			return "", api
		}
		if strings.TrimSpace(clientID) != opened.ClientID {
			return "", contract.Validation("Client ID 已变更，请输入对应的 API Key")
		}
		apiKey = opened.APIKey
	}
	client, key, api := domain.NormalizeCredential(clientID, apiKey)
	if api != nil {
		return "", api
	}
	status, body, err := s.info.PostSellerInfo(ctx, client, key)
	defer clear(body)
	if err != nil || status < 200 || status >= 300 {
		if status == 401 || status == 403 {
			return "", contract.Validation("无法读取店铺名称，请检查 Client ID、API Key 和 Seller 信息读取权限")
		}
		return "", contract.Unreachable("店铺名称暂时无法读取，请稍后重试")
	}
	company, parsed := domain.ParseSellerInfo(body)
	if name := domain.KeepShort(company.ShortName); parsed && name != "" {
		return name, nil
	}
	return "", contract.Validation("API 未返回有效的店铺名称，可手动填写")
}

// RegisterCredential is POST /api/workspaces/stores/{uuid}/credential.
//
// The probe runs before the transaction opens: the claimed Client ID belongs to
// nobody until the write commits, so it must not spend that account's budget.
func (s Service) RegisterCredential(ctx context.Context, orgID, userID int64, uuid, clientID, apiKey string, expectedStoreRevision int64, expectedCredentialRevision *int64, confirmUpload bool) (domain.RegisterOutcome, *contract.APIError) {
	if s.credential == nil || s.roster == nil {
		return domain.RegisterOutcome{}, contract.Internal()
	}
	if !confirmUpload {
		return domain.RegisterOutcome{}, contract.Validation(contract.MsgConfirmUpload)
	}
	normalized, ok := domain.NormalizeStoreUUID(uuid)
	if !ok {
		return domain.RegisterOutcome{}, contract.Validation(contract.MsgStoreUUID)
	}
	client, key, api := domain.NormalizeCredential(clientID, apiKey)
	if api != nil {
		return domain.RegisterOutcome{}, api
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return domain.RegisterOutcome{}, api
	}
	if !actor.CanManageAll() {
		return domain.RegisterOutcome{}, contract.Forbidden(contract.MsgNoKeyPermission)
	}
	expires, api := s.probeCredential(ctx, client, key)
	if api != nil {
		return domain.RegisterOutcome{}, api
	}
	var written domain.RegisterOutcome
	api = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesCredential, func(ctx context.Context, tx domain.RosterTx) error {
		outcome, err := tx.RegisterCredential(ctx, orgID, actor, normalized, client, key, expectedStoreRevision, expectedCredentialRevision, expires)
		if err != nil {
			return err
		}
		written = outcome
		action := "store_credential_registered"
		if outcome.Rotated {
			action = "store_credential_rotated"
		}
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleCredential,
			EntityType: entityStore,
			EntityID:   normalized,
			Method:     "POST",
			Path:       "/api/workspaces/stores/{uuid}/credential",
			Action:     action,
			Message: map[string]any{
				"uuid":                normalized,
				"client_id":           client,
				"credential_revision": outcome.CredentialRevision,
				"fingerprint_changed": outcome.FingerprintChanged,
				"rotated":             outcome.Rotated,
			},
		})
	})
	if api != nil {
		return domain.RegisterOutcome{}, api
	}
	if s.info != nil && s.dir != nil {
		filled, err := s.OnCredentialSaved(ctx, orgID, normalized, client, key)
		if err != nil {
			slog.Warn("store name fill failed after credential save", "org_id", orgID, "store_id", normalized)
		} else {
			written.NameFilled = filled.Filled
		}
	}
	return written, nil
}

// DeleteCredential is DELETE /api/workspaces/stores/{uuid}/credential.
func (s Service) DeleteCredential(ctx context.Context, orgID, userID int64, uuid string, expectedStoreRevision, expectedCredentialRevision int64) (string, int64, *contract.APIError) {
	if s.roster == nil {
		return "", 0, contract.Internal()
	}
	normalized, ok := domain.NormalizeStoreUUID(uuid)
	if !ok {
		return "", 0, contract.Validation(contract.MsgStoreUUID)
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return "", 0, api
	}
	var revision int64
	api = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesCredential, func(ctx context.Context, tx domain.RosterTx) error {
		next, err := tx.DeleteCredential(ctx, orgID, actor, normalized, expectedStoreRevision, expectedCredentialRevision)
		if err != nil {
			return err
		}
		revision = next
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleCredential,
			EntityType: entityStore,
			EntityID:   normalized,
			Method:     "DELETE",
			Path:       "/api/workspaces/stores/{uuid}/credential",
			Action:     "store_credential_deleted",
			Message: map[string]any{
				"uuid":                normalized,
				"credential_revision": expectedCredentialRevision,
				"reason":              "explicit",
			},
		})
	})
	if api != nil {
		return "", 0, api
	}
	return normalized, revision, nil
}

// TestCredential is POST /api/workspaces/stores/{uuid}/credential/test.
//
// The probe runs outside the write transaction so a slow Seller cannot pin the
// row; the write then re-checks that the generation probed is still current,
// which is what makes the recorded answer mean something.
func (s Service) TestCredential(ctx context.Context, orgID, userID int64, uuid string) (domain.VerifyResult, *contract.APIError) {
	if s.credential == nil || s.roster == nil {
		return domain.VerifyResult{}, contract.Internal()
	}
	normalized, ok := domain.NormalizeStoreUUID(uuid)
	if !ok {
		return domain.VerifyResult{}, contract.Validation(contract.MsgStoreUUID)
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return domain.VerifyResult{}, api
	}
	opened, api := s.credential.OpenCurrentCredential(ctx, orgID, actor, normalized)
	if api != nil {
		return domain.VerifyResult{}, api
	}
	verdict := domain.ProbeOutcome{Verified: true}
	var expires *int64
	status, body, callErr := s.credential.ProbeRoles(ctx, opened.ClientID, opened.APIKey)
	if callErr != nil {
		verdict = domain.ClassifyProbe(0, nil)
	} else {
		verdict = domain.ClassifyProbe(status, body)
		if verdict.Verified {
			expires = domain.ParseRolesExpiry(body)
		}
	}
	s.credential.MarkLeased(ctx, orgID, opened.StoreID, opened.CredentialRevision, domain.NowMS())
	var summary domain.VerificationSummary
	api = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesVerify, func(ctx context.Context, tx domain.RosterTx) error {
		saved, err := tx.VerifyCredential(ctx, orgID, actor, normalized, opened.CredentialRevision, verdict.Verified, verdict.Code, expires)
		if err != nil {
			return err
		}
		summary = saved
		action := "store_credential_rejected"
		if verdict.Verified {
			action = "store_credential_verified"
		}
		var code any
		if verdict.Code != "" {
			code = verdict.Code
		}
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleCredential,
			EntityType: entityStore,
			EntityID:   normalized,
			Method:     "POST",
			Path:       "/api/workspaces/stores/{uuid}/credential/test",
			Action:     action,
			Message: map[string]any{
				"uuid":                normalized,
				"credential_revision": opened.CredentialRevision,
				"verified":            verdict.Verified,
				"failure_code":        code,
			},
		})
	})
	if api != nil {
		return domain.VerifyResult{}, api
	}
	// A rejection is recorded — the operator needs to see the key was tested and
	// refused — but the response is the probe's own sentence.
	if !verdict.Verified {
		return domain.VerifyResult{}, contract.Validation(verdict.Reason)
	}
	if summary.LatestVerifiedAtMS == nil {
		return domain.VerifyResult{}, &contract.APIError{
			Status: 500, Code: contract.CodeInternal, Message: contract.MsgVerifyNotSaved,
		}
	}
	// The key is open and proven live: refill this one store's snapshots now so
	// the roster the SPA re-reads after a probe shows current figures. Best
	// effort, like the loops: a failed read keeps the previous snapshot.
	refreshedAt := domain.NowMS()
	s.refreshSnapshot(ctx, orgID, normalized, opened, refreshedAt, refreshProducts)
	s.refreshSnapshot(ctx, orgID, normalized, opened, refreshedAt, refreshFinance)
	if s.info != nil && s.dir != nil {
		if _, err := s.OnCredentialVerified(ctx, orgID, normalized, opened.ClientID, opened.APIKey); err != nil {
			slog.Warn("store name fill failed after credential verification", "org_id", orgID, "store_id", normalized)
		}
	}
	return domain.VerifyResult{
		StoreUUID:          normalized,
		CredentialRevision: opened.CredentialRevision,
		VerifiedAtMS:       *summary.LatestVerifiedAtMS,
	}, nil
}

// ExportCredentials is POST /api/workspaces/stores/credentials/export. The
// audit row counts the keys; it never holds one.
func (s Service) ExportCredentials(ctx context.Context, orgID, userID int64) ([]domain.ExportedCredential, *contract.APIError) {
	if s.credential == nil || s.roster == nil {
		return nil, contract.Internal()
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return nil, api
	}
	if !actor.CanManageAll() {
		return nil, contract.Forbidden(contract.MsgNoKeyPermission)
	}
	items, api := s.credential.Export(ctx, orgID, actor)
	if api != nil {
		return nil, api
	}
	uuids := make([]string, 0, len(items))
	for _, item := range items {
		uuids = append(uuids, item.UUID)
	}
	api = s.roster.WriteTx(ctx, orgID, userID, contract.MsgWritesCredential, func(ctx context.Context, tx domain.RosterTx) error {
		return tx.Record(ctx, domain.AuditRow{
			Module:     moduleCredential,
			EntityType: entityStore,
			EntityID:   "credentials",
			Method:     "POST",
			Path:       "/api/workspaces/stores/credentials/export",
			Action:     "store_credential_exported",
			Message:    map[string]any{"count": len(items), "uuids": uuids},
		})
	})
	if api != nil {
		return nil, api
	}
	return items, nil
}

// probeCredential runs /v1/roles for a pair that is not stored yet and returns
// the key's expiry. A refused key never reaches a transaction, so a typo leaves
// no audit trail to explain.
func (s Service) probeCredential(ctx context.Context, clientID, apiKey string) (*int64, *contract.APIError) {
	status, body, err := s.credential.ProbeRoles(ctx, clientID, apiKey)
	if err != nil {
		// The sentence says the gateway is unreachable; the log keeps the cause.
		slog.Warn("credential probe refused", "reason", err.Error())
		return nil, contract.Unreachable(contract.MsgVerifyGateway)
	}
	verdict := domain.ClassifyProbe(status, body)
	if !verdict.Verified {
		return nil, contract.Validation(verdict.Reason)
	}
	return domain.ParseRolesExpiry(body), nil
}
