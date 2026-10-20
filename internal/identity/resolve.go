package identity

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func (s *Service) resolveToken(ctx context.Context, token string) (account, bool, error) {
	row, err := s.q(ctx).ResolveAccount(ctx, hashToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return account{}, false, nil
	}
	if err != nil {
		return account{}, false, err
	}
	return account{
		id: row.ID, publicID: row.PublicID, email: row.Email, role: row.Role,
		name: row.Name, supplierID: row.SupplierID, orgID: row.OrgID,
		workspaceRole: row.WorkspaceRole,
	}, true, nil
}

// Resolve implements access.Resolver. The workspace role is the stored
// membership string from the same lateral join as the session. A database
// error is returned as err so the read handlers answer 500. Logged out is
// a nil principal. Confirmed TOTP step-up is not applied here: login already
// refuses to issue a session when a super admin's totp row is confirmed, and
// an existing session is not re-checked.
func (s *Service) Resolve(r *http.Request) (*access.Principal, *access.Refusal, error) {
	if s == nil || s.pool == nil {
		if SessionCredentials(r.Header).Presented() == "" {
			return nil, nil, nil
		}
		return nil, nil, errors.New("no pool")
	}
	_, token, acc, err := s.resolveRequest(r)
	if err != nil {
		return nil, nil, err
	}
	if token == "" {
		return nil, nil, nil
	}
	return &access.Principal{
		UserID:        acc.id,
		OrgID:         acc.orgID,
		WorkspaceRole: acc.workspaceRole,
		PlatformRole:  acc.role,
		Email:         acc.email,
		PublicID:      acc.publicID,
		TokenHash:     hashToken(token),
	}, nil, nil
}

func (s *Service) resolveRequest(r *http.Request) (Credentials, string, account, error) {
	cred := SessionCredentials(r.Header)
	var zero account
	for _, token := range cred.Candidates() {
		acc, ok, err := s.resolveToken(r.Context(), token)
		if err != nil {
			return cred, "", zero, err
		}
		if ok {
			return cred, token, acc, nil
		}
	}
	return cred, "", zero, nil
}

func (s *Service) requireAccount(r *http.Request) (Credentials, string, account, Result, bool) {
	if s.pool == nil {
		return Credentials{}, "", account{}, dbResult(errors.New("no pool")), false
	}
	cred, token, acc, err := s.resolveRequest(r)
	if err != nil {
		return cred, "", account{}, dbResult(err), false
	}
	if token == "" {
		return cred, "", account{}, authResult(http.StatusUnauthorized, msgLoggedOut, "AUTH_INVALID"), false
	}
	return cred, token, acc, Result{}, true
}
