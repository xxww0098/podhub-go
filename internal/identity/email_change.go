package identity

import (
	"errors"
	"net/http"
	"sort"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func (s *Service) RequestEmailChange(r *http.Request) Result {
	_, session, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	if s.emailChangeMailer == nil || len(s.resetKey) != 32 {
		return authResult(http.StatusServiceUnavailable, "邮件服务暂不可用，请稍后重试", "UNAVAILABLE")
	}
	var body struct {
		Email           string `json:"email"`
		CurrentPassword string `json:"current_password"`
	}
	if !decodeBoundedJSON(r, &body) {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	email := strings.TrimSpace(body.Email)
	if !EmailShaped(email) || len(email) > 320 || strings.IndexFunc(email, unicode.IsControl) >= 0 {
		return authResult(http.StatusBadRequest, "邮箱格式无效", "VALIDATION")
	}
	if strings.EqualFold(email, acc.email) {
		return authResult(http.StatusBadRequest, "新邮箱不能与当前邮箱相同", "VALIDATION")
	}
	ip := recoveryIP(r)
	if wait, err := s.waiting(r.Context(), acc.email, ip); err != nil {
		return dbResult(err)
	} else if wait {
		return authResult(http.StatusTooManyRequests, msgThrottle, "RATE_LIMITED")
	}
	if !s.acquirePassword() {
		return authResult(http.StatusTooManyRequests, msgBusyHash, "RATE_LIMITED")
	}
	defer s.releasePassword()
	user, err := s.findUserByEmail(r.Context(), acc.email)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && user.ID != acc.id {
		return authResult(http.StatusUnauthorized, msgCredentialDrift, "AUTH_INVALID")
	}
	if err != nil {
		return dbResult(err)
	}
	if !verifyPassword(body.CurrentPassword, user.PasswordHash) {
		s.recordFailure(r.Context(), acc.email, ip)
		return authResult(http.StatusBadRequest, msgBadCurrent, "VALIDATION")
	}
	if _, err := s.findUserByEmail(r.Context(), email); err == nil {
		return authResult(http.StatusConflict, msgRegistered, "VALIDATION")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return dbResult(err)
	}
	token, err := randomToken()
	if err != nil {
		return dbResult(err)
	}
	digest := hashToken(token)
	nonce, ciphertext, err := seal.SealBlob(s.resetKey, recoveryAAD+digest, []byte(token))
	if err != nil {
		return dbResult(err)
	}
	err = s.inTx(r.Context(), func(tx pgx.Tx, q *sqlc.Queries) (bool, error) {
		ctx := r.Context()
		current, err := q.AssertPassword(ctx, acc.id)
		if err != nil {
			return false, err
		}
		if current.Disabled || current.PasswordHash != user.PasswordHash || current.SessionRevision != user.SessionRevision || !strings.EqualFold(current.Email, acc.email) {
			return false, errDrift
		}
		var active bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM account_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp())`, hashToken(session), acc.id).Scan(&active); err != nil {
			return false, err
		}
		if !active {
			return false, errDrift
		}
		recent, err := q.RecentEmailChange(ctx, acc.id)
		if err != nil {
			return false, err
		}
		if recent {
			return false, errEmailChangeCooldown
		}
		if err := q.CancelEmailChanges(ctx, acc.id); err != nil {
			return false, err
		}
		if err := q.CancelEmailChangeDeliveries(ctx, acc.id); err != nil {
			return false, err
		}
		if err := q.InsertEmailChange(ctx, sqlc.InsertEmailChangeParams{TokenHash: digest, UserID: acc.id, NewEmail: pgtype.Text{String: email, Valid: true}}); err != nil {
			return false, err
		}
		if err := q.InsertResetDelivery(ctx, sqlc.InsertResetDeliveryParams{TokenHash: digest, SecretNonce: nonce, SecretCiphertext: ciphertext}); err != nil {
			return false, err
		}
		if err := s.clearFailure(ctx, q, acc.email, ip); err != nil {
			return false, err
		}
		return true, q.InsertAudit(ctx, sqlc.InsertAuditParams{OrgID: acc.orgID, UserID: acc.id, Module: "auth", EntityType: "account", EntityID: acc.publicID, ApiMethod: "POST", ApiPath: "/api/auth/email/change", Action: "email_change_requested", Message: `{"summary":"申请更换邮箱"}`})
	})
	if errors.Is(err, errEmailChangeCooldown) {
		res := authResult(http.StatusTooManyRequests, "请稍后再申请换绑邮件", "RATE_LIMITED")
		res.RetryAfter = "60"
		return res
	}
	if errors.Is(err, errDrift) {
		return authResult(http.StatusUnauthorized, msgCredentialDrift, "AUTH_INVALID")
	}
	if err != nil {
		return dbResult(err)
	}
	return Result{Status: http.StatusOK, Body: []byte(`{"data":{"ok":true}}`)}
}

var errEmailChangeCooldown = errors.New("email change cooldown")

func (s *Service) ConfirmEmailChange(r *http.Request) Result {
	if s.pool == nil {
		return dbResult(errors.New("no pool"))
	}
	var body struct {
		Token string `json:"token"`
	}
	if !decodeBoundedJSON(r, &body) || !IsSessionToken(body.Token) {
		return authResult(http.StatusBadRequest, msgBadLink, "VALIDATION")
	}
	digest := hashToken(body.Token)
	err := s.inTx(r.Context(), func(tx pgx.Tx, q *sqlc.Queries) (bool, error) {
		ctx := r.Context()
		change, err := q.FindEmailChange(ctx, digest)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, errBadLink
		}
		if err != nil {
			return false, err
		}
		// Registration takes these locks before inserting an account.
		emails := []string{strings.ToLower(change.Email), strings.ToLower(change.NewEmail)}
		sort.Strings(emails)
		for _, email := range emails {
			if err := lockInvitationEmail(ctx, tx, email); err != nil {
				return false, err
			}
		}
		current, err := q.LockUserState(ctx, change.UserID)
		if err != nil {
			return false, err
		}
		if current.Disabled || !strings.EqualFold(current.Email, change.Email) {
			return false, errBadLink
		}
		if _, err := q.ConsumeEmailToken(ctx, sqlc.ConsumeEmailTokenParams{TokenHash: digest, Purpose: "change_email"}); errors.Is(err, pgx.ErrNoRows) {
			return false, errBadLink
		} else if err != nil {
			return false, err
		}
		if err := q.UpdateUserEmail(ctx, sqlc.UpdateUserEmailParams{Email: change.NewEmail, ID: change.UserID}); err != nil {
			return false, err
		}
		if _, err := q.DeleteUserSessions(ctx, change.UserID); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `UPDATE org_invitations SET revoked_at=clock_timestamp(),updated_at=clock_timestamp()
		 WHERE lower(email)=lower($1) AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL AND expires_at<=clock_timestamp()
		 AND org_id IN (SELECT org_id FROM org_invitations WHERE invitee_user_id=$2 AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp())`, change.NewEmail, change.UserID); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `UPDATE org_invitations SET email=lower($2),updated_at=clock_timestamp() WHERE invitee_user_id=$1 AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()`, change.UserID, change.NewEmail); err != nil {
			return false, err
		}
		return true, q.InsertAudit(ctx, sqlc.InsertAuditParams{OrgID: 0, UserID: change.UserID, Module: "auth", EntityType: "account", EntityID: itoa(change.UserID), ApiMethod: "POST", ApiPath: "/api/auth/email/confirm", Action: "email_changed", Message: `{"summary":"更换登录邮箱"}`})
	})
	if errors.Is(err, errBadLink) {
		return authResult(http.StatusBadRequest, msgBadLink, "VALIDATION")
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && (pgErr.ConstraintName == "uq_account_users_email_lower" || pgErr.ConstraintName == "uq_account_users_email") {
		return authResult(http.StatusConflict, msgRegistered, "VALIDATION")
	}
	if err != nil {
		return dbResult(err)
	}
	return Result{Status: http.StatusOK, Body: []byte(`{"data":{"ok":true}}`)}
}
