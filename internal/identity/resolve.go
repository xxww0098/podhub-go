package identity

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

func (s *Service) resolveToken(ctx context.Context, token string) (account, bool, error) {
	var row sqlc.ResolveAccountRow
	err := db.InTx(ctx, s.pool, db.Staff(), func(tx pgx.Tx) error {
		var err error
		row, err = sqlc.New(tx).ResolveAccount(ctx, hashToken(token))
		return err
	})
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
		accountKind:   row.AccountKind, mustChangePassword: row.MustChangePassword,
	}, true, nil
}

// Resolve implements access.Resolver. The workspace role is the stored
// membership string from the same lateral join as the session. A database
// error is returned as err so the read handlers answer 500. Logged out is
// a nil principal. Management handlers check the platform role themselves.
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
	token := cred.Presented()
	if token == "" {
		return cred, "", account{}, nil
	}
	acc, ok, err := s.resolveToken(r.Context(), token)
	if err != nil || !ok {
		return cred, "", account{}, err
	}
	return cred, token, acc, nil
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
