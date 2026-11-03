package identity

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

func (s *Service) Password(r *http.Request) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	if !s.acquirePassword() {
		return authResult(http.StatusTooManyRequests, msgBusyHash, "RATE_LIMITED")
	}
	defer s.releasePassword()
	var body struct {
		Current string `json:"current_password"`
		New     string `json:"new_password"`
	}
	if err := strictJSON(r, &body); err != nil {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	if utf8.RuneCountInString(body.New) < 8 || len(body.New) > maxPasswordBytes {
		return authResult(http.StatusBadRequest, msgPasswordBounds, "VALIDATION")
	}
	user, err := s.findUserByEmail(r.Context(), acc.email)
	if err != nil {
		return dbResult(err)
	}
	if !verifyPassword(body.Current, user.PasswordHash) {
		return authResult(http.StatusBadRequest, msgBadCurrent, "VALIDATION")
	}
	if verifyPassword(body.New, user.PasswordHash) {
		return authResult(http.StatusBadRequest, msgSamePassword, "VALIDATION")
	}
	nextHash, err := hashPassword(body.New)
	if err != nil {
		return dbResult(err)
	}
	token, err := s.sessionToken(r, nextHash, user.SessionRevision)
	if err != nil {
		return dbResult(err)
	}
	var revoked int64
	err = s.inTx(r.Context(), func(_ pgx.Tx, q *sqlc.Queries) (bool, error) {
		row, err := q.AssertPassword(r.Context(), acc.id)
		if err != nil {
			return false, err
		}
		if row.PasswordHash != user.PasswordHash || row.SessionRevision != user.SessionRevision || row.Disabled {
			return true, errDrift
		}
		if err := q.ReplacePassword(r.Context(), sqlc.ReplacePasswordParams{PasswordHash: nextHash, ID: acc.id}); err != nil {
			return false, err
		}
		// A self password change is the one write that clears the lock: the same
		// transaction swaps the hash and lifts must_change_password, so the flag
		// can never outlive the password it was set against. Provision and staff
		// SetPassword set it to true (doc §4.2); POST /api/auth/reset leaves it
		// alone on purpose — a reset session is not signed in, and the user
		// unlocks by signing in and changing the password here.
		if err := q.ClearMustChangePassword(r.Context(), acc.id); err != nil {
			return false, err
		}
		n, err := q.DeleteUserSessions(r.Context(), acc.id)
		if err != nil {
			return false, err
		}
		revoked = n
		if err := q.IssueSession(r.Context(), sqlc.IssueSessionParams{
			TokenHash: hashToken(token), UserID: acc.id,
			Column3: time.Now().UTC().Add(sessionTTL(acc.role)).Format(time.RFC3339Nano),
		}); err != nil {
			return false, err
		}
		if err := q.TouchLastLogin(r.Context(), acc.id); err != nil {
			return false, err
		}
		message, _ := json.Marshal(struct {
			Summary         string `json:"summary"`
			SessionsRevoked int64  `json:"sessions_revoked"`
		}{Summary: "修改密码", SessionsRevoked: n})
		return true, q.InsertAudit(r.Context(), sqlc.InsertAuditParams{
			OrgID: acc.orgID, UserID: acc.id, Module: "auth", EntityType: "account",
			EntityID: acc.publicID, ApiMethod: "POST", ApiPath: "/api/auth/password",
			Action: "password_changed", Message: string(message),
		})
	})
	if errors.Is(err, errDrift) {
		return authResult(http.StatusUnauthorized, msgCredentialDrift, "AUTH_INVALID")
	}
	if err != nil {
		return dbResult(err)
	}
	_ = revoked
	return Result{
		Status:  http.StatusOK,
		Body:    loginBody(token, user.PublicID, user.Role, user.Email, acc.name, user.SupplierID, user.Target),
		Cookies: SessionCookies(token),
	}
}

func (s *Service) Forgot(r *http.Request) Result {
	var body struct {
		Email string `json:"email"`
	}
	if err := strictJSON(r, &body); err != nil {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	return s.forgot(r, body.Email)
}

func (s *Service) Reset(r *http.Request) Result {
	if s.pool == nil {
		return dbResult(errors.New("no pool"))
	}
	var body struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if err := strictJSON(r, &body); err != nil {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	if utf8.RuneCountInString(body.Password) < 8 || len(body.Password) > maxPasswordBytes {
		return authResult(http.StatusBadRequest, msgPasswordBounds, "VALIDATION")
	}
	if !IsSessionToken(body.Token) {
		return authResult(http.StatusBadRequest, msgBadLink, "VALIDATION")
	}
	if !s.acquirePassword() {
		return authResult(http.StatusTooManyRequests, msgBusyHash, "RATE_LIMITED")
	}
	defer s.releasePassword()
	hash, err := hashPassword(body.Password)
	if err != nil {
		return dbResult(err)
	}
	err = s.inTx(r.Context(), func(_ pgx.Tx, q *sqlc.Queries) (bool, error) {
		userID, err := q.ResetTokenOwner(r.Context(), hashToken(body.Token))
		if errors.Is(err, pgx.ErrNoRows) {
			return true, errBadLink
		}
		if err != nil {
			return false, err
		}
		state, err := q.LockUserState(r.Context(), userID)
		if err != nil {
			return false, err
		}
		if state.Disabled {
			return true, errDisabled
		}
		// All recovery writers lock user before token, including two different
		// links for the same user. Consumption rechecks validity after the lock.
		if _, err := q.ConsumeEmailToken(r.Context(), sqlc.ConsumeEmailTokenParams{TokenHash: hashToken(body.Token), Purpose: "reset"}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return true, errBadLink
			}
			return false, err
		}
		if err := q.ReplacePassword(r.Context(), sqlc.ReplacePasswordParams{PasswordHash: hash, ID: userID}); err != nil {
			return false, err
		}
		// Deliberately does NOT clear must_change_password: this path is not
		// signed in and belongs to the forgot-password flow, not to the doc
		// §4.2 write points. The user signs in and clears it via
		// POST /api/auth/password, which the gate keeps reachable.
		if _, err := q.DeleteUserSessions(r.Context(), userID); err != nil {
			return false, err
		}
		return true, q.InsertAudit(r.Context(), sqlc.InsertAuditParams{
			OrgID: 0, UserID: userID, Module: "auth", EntityType: "account",
			EntityID: itoa(userID), ApiMethod: "POST", ApiPath: "/api/auth/reset",
			Action: "password_reset", Message: `{"summary":"重置密码"}`,
		})
	})
	if errors.Is(err, errBadLink) {
		return authResult(http.StatusBadRequest, msgBadLink, "VALIDATION")
	}
	if errors.Is(err, errDisabled) {
		return authResult(http.StatusUnauthorized, msgDisabled, "AUTH_INVALID")
	}
	if err != nil {
		return dbResult(err)
	}
	return Result{Status: http.StatusOK, Body: []byte(`{"data":{"ok":true}}`)}
}
