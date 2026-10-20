package service

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"

	"github.com/xxww0098/podhub-go/internal/warehouse/contract"
	"github.com/xxww0098/podhub-go/internal/warehouse/domain"
)

// Grant records the intent and only then opens the store key.
// It does not dial Ozon. The kill switch returns before the opener.
func (s Service) Grant(ctx context.Context, in GrantInput) (GrantResult, error) {
	if in.WritesDisabled {
		if s.DB != nil {
			_ = s.DB.AuditRefused(ctx, in.OrgID, in.UserID, in.StoreID, in.Kind)
		}
		return GrantResult{}, contract.WritesDisabled()
	}
	in.ClientOperationID = strings.TrimSpace(in.ClientOperationID)
	in.RequestHash = strings.TrimSpace(in.RequestHash)
	if err := validateGrant(in.GrantWrite); err != nil {
		return GrantResult{}, err
	}
	if err := s.reserve(ctx, "warehouse-grant:"+in.StoreID); err != nil {
		return GrantResult{}, err
	}
	if s.DB == nil {
		return GrantResult{}, contract.Unavailable()
	}
	in.Now = s.now()
	prepared, err := s.DB.PrepareGrant(ctx, in.GrantWrite)
	if err != nil {
		return GrantResult{}, err
	}
	clientID, apiKey, err := s.open(ctx, Actor{
		OrgID: in.OrgID, UserID: in.UserID, Role: in.Role, StoreID: in.StoreID,
	})
	if err != nil {
		return GrantResult{}, err
	}
	return GrantResult{
		IntentID:    prepared.IntentID,
		State:       prepared.State,
		ClientID:    clientID,
		APIKey:      apiKey,
		ExpiresAtMS: in.Now.Add(domain.GrantTTL).UnixMilli(),
		TTLMS:       domain.GrantTTL.Milliseconds(),
	}, nil
}

// Report applies one browser result. A failure leaves the row unchanged.
func (s Service) Report(ctx context.Context, in contract.ReportWrite) (contract.ReportDone, error) {
	if _, err := uuid.Parse(in.IntentID); err != nil {
		return contract.ReportDone{}, contract.BadRequest("intentId 无效")
	}
	if s.DB == nil {
		return contract.ReportDone{}, contract.Unavailable()
	}
	in.Now = s.now()
	in.OperationID = strings.TrimSpace(in.OperationID)
	if len(in.OperationID) > 128 {
		return contract.ReportDone{}, contract.BadRequest("operationId 过长")
	}
	done, err := s.DB.ApplyReport(ctx, in)
	if err != nil {
		return contract.ReportDone{}, err
	}
	if done.ErrorCode != "" && in.HTTPStatus != nil {
		s.record(ctx, in.OrgID, "wh:"+done.IntentID, *in.HTTPStatus, "")
	}
	return done, nil
}

func validateGrant(in contract.GrantWrite) error {
	if in.OrgID <= 0 || in.UserID <= 0 {
		return contract.Forbidden()
	}
	if _, err := uuid.Parse(in.StoreID); err != nil {
		return contract.BadRequest("storeId 无效")
	}
	in.ClientOperationID = strings.TrimSpace(in.ClientOperationID)
	if in.ClientOperationID == "" || len(in.ClientOperationID) > 128 {
		return contract.BadRequest("clientOperationId 无效")
	}
	if !domain.KnownKind(in.Kind) {
		return contract.BadRequest("不支持的写操作")
	}
	if len(in.RequestHash) > 128 {
		return contract.BadRequest("requestHash 过长")
	}
	return nil
}

func (s Service) reserve(ctx context.Context, scope string) error {
	if s.Limit == nil {
		return contract.Unavailable()
	}
	err := s.Limit.Reserve(ctx, scope)
	if err == nil {
		return nil
	}
	if errors.Is(err, contract.ErrRateLimited) {
		return contract.RateLimited()
	}
	return contract.Unavailable()
}

func (s Service) open(ctx context.Context, actor Actor) (string, string, error) {
	if s.Open == nil {
		return "", "", contract.CredentialUnavailable()
	}
	clientID, apiKey, err := s.Open.Open(ctx, actor.OrgID, actor.UserID, actor.Role, actor.StoreID, s.now())
	if err != nil {
		var open *contract.OpenError
		if errors.As(err, &open) && open.Status != 0 {
			code := open.Code
			if code == "" {
				code = "credential_unavailable"
			}
			return "", "", &contract.Fail{Status: open.Status, Code: code, Message: open.Message}
		}
		return "", "", contract.CredentialUnavailable()
	}
	if clientID == "" || apiKey == "" {
		return "", "", contract.CredentialUnavailable()
	}
	return clientID, apiKey, nil
}

func (s Service) record(ctx context.Context, orgID int64, path string, status int, code string) {
	if s.Errors == nil {
		return
	}
	if code == "" {
		code = "http"
	}
	s.Errors.RecordOzon(ctx, orgID, path, status, code)
}
