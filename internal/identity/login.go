package identity

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

func (s *Service) waiting(ctx context.Context, email, ip string) (bool, error) {
	q := s.q(ctx)
	emailH, ipH := pairKey(email, ip)
	if wait, err := waitingRow(ctx, q, emailH[:], ipH[:]); err != nil || wait {
		return wait, err
	}
	zeros := ipScope()
	return waitingRow(ctx, q, zeros[:], ipH[:])
}

func waitingRow(ctx context.Context, q *sqlc.Queries, emailH, ipH []byte) (bool, error) {
	wait, err := q.LoginWaiting(ctx, sqlc.LoginWaitingParams{EmailHash: emailH, IpHash: ipH})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return wait, err
}

func (s *Service) recordFailure(ctx context.Context, email, ip string) {
	q := s.q(ctx)
	emailH, ipH := pairKey(email, ip)
	_ = q.BumpLoginAttempt(ctx, sqlc.BumpLoginAttemptParams{EmailHash: emailH[:], IpHash: ipH[:], Column3: pairFree})
	zeros := ipScope()
	_ = q.BumpLoginAttempt(ctx, sqlc.BumpLoginAttemptParams{EmailHash: zeros[:], IpHash: ipH[:], Column3: ipFree})
	_ = q.PruneLoginAttempts(ctx, pruneBatch)
}

func (s *Service) clearFailure(ctx context.Context, q *sqlc.Queries, email, ip string) error {
	emailH, ipH := pairKey(email, ip)
	return q.ClearLoginAttempt(ctx, sqlc.ClearLoginAttemptParams{EmailHash: emailH[:], IpHash: ipH[:]})
}

func (s *Service) Login(r *http.Request) Result {
	if s.pool == nil {
		return dbResult(errors.New("no pool"))
	}
	if !s.acquirePassword() {
		return authResult(http.StatusTooManyRequests, msgBusyHash, "RATE_LIMITED")
	}
	defer s.releasePassword()
	var body struct {
		Email    string  `json:"email"`
		Password string  `json:"password"`
		TotpCode *string `json:"totpCode"`
	}
	if err := strictJSON(r, &body); err != nil {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	email := strings.TrimSpace(body.Email)
	ip := ClientIP(r.Header)
	if wait, err := s.waiting(r.Context(), email, ip); err != nil {
		return dbResult(err)
	} else if wait {
		return authResult(http.StatusTooManyRequests, msgThrottle, "RATE_LIMITED")
	}
	if email == "" || utf8.RuneCountInString(body.Password) < 8 {
		performDummyVerify(body.Password)
		s.recordFailure(r.Context(), email, ip)
		return authResult(http.StatusUnauthorized, msgBadLogin, "AUTH_INVALID")
	}
	user, err := s.q(r.Context()).FindUserByEmail(r.Context(), email)
	if errors.Is(err, pgx.ErrNoRows) {
		performDummyVerify(body.Password)
		s.recordFailure(r.Context(), email, ip)
		return authResult(http.StatusUnauthorized, msgBadLogin, "AUTH_INVALID")
	}
	if err != nil {
		return dbResult(err)
	}
	if !verifyPassword(body.Password, user.PasswordHash) {
		s.recordFailure(r.Context(), email, ip)
		return authResult(http.StatusUnauthorized, msgBadLogin, "AUTH_INVALID")
	}
	if user.Disabled {
		_ = s.clearFailure(r.Context(), s.q(r.Context()), email, ip)
		return authResult(http.StatusUnauthorized, msgDisabled, "AUTH_INVALID")
	}
	if RoleFromStored(user.Role).IsSuperAdmin() {
		confirmed, err := s.q(r.Context()).TotpConfirmed(r.Context(), user.ID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return dbResult(err)
		}
		if err == nil && confirmed {
			return authResult(http.StatusUnauthorized, msgTotp, "TOTP_REQUIRED")
		}
	}
	token, err := s.sessionToken(r, user.PasswordHash)
	if err != nil {
		return dbResult(err)
	}
	cred := SessionCredentials(r.Header)
	live, err := s.liveStack(r.Context(), cred)
	if err != nil {
		return dbResult(err)
	}
	var orgID int64
	err = s.inTx(r.Context(), func(q *sqlc.Queries) (bool, error) {
		if err := s.issue(r.Context(), q, user.ID, user.Role, token, "POST", "/api/auth/login", "session_issued", `{"summary":"签发会话"}`, 0); err != nil {
			return false, err
		}
		if err := s.clearFailure(r.Context(), q, email, ip); err != nil {
			return false, err
		}
		active, err := q.UserActiveOrg(r.Context(), user.ID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return false, err
		}
		if active.Valid {
			orgID = active.Int64
		}
		return true, nil
	})
	if err != nil {
		return dbResult(err)
	}
	stack := MergedStack(live, user.ID, token)
	res := Result{
		Status:  http.StatusOK,
		Body:    loginBody(token, user.PublicID, user.Role, user.Email, user.Name, user.SupplierID, user.Target),
		Cookies: SessionCookies(token, stack),
	}
	_ = orgID
	return res
}

func (s *Service) sessionToken(r *http.Request, passwordHash string) (string, error) {
	if key := strings.TrimSpace(r.Header.Get("Idempotency-Key")); key != "" {
		return DeriveSessionToken(passwordHash, key), nil
	}
	return randomToken()
}
