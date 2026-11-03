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
	var wait bool
	err := s.withQueries(ctx, func(q *sqlc.Queries) error {
		emailH, ipH := pairKey(email, ip)
		var err error
		wait, err = waitingRow(ctx, q, emailH[:], ipH[:])
		if err != nil || wait {
			return err
		}
		zeros := ipScope()
		wait, err = waitingRow(ctx, q, zeros[:], ipH[:])
		return err
	})
	return wait, err
}

func waitingRow(ctx context.Context, q *sqlc.Queries, emailH, ipH []byte) (bool, error) {
	wait, err := q.LoginWaiting(ctx, sqlc.LoginWaitingParams{EmailHash: emailH, IpHash: ipH})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return wait, err
}

func (s *Service) recordFailure(ctx context.Context, email, ip string) {
	_ = s.withQueries(ctx, func(q *sqlc.Queries) error {
		emailH, ipH := pairKey(email, ip)
		if err := q.BumpLoginAttempt(ctx, sqlc.BumpLoginAttemptParams{EmailHash: emailH[:], IpHash: ipH[:], Column3: pairFree}); err != nil {
			return err
		}
		zeros := ipScope()
		if err := q.BumpLoginAttempt(ctx, sqlc.BumpLoginAttemptParams{EmailHash: zeros[:], IpHash: ipH[:], Column3: ipFree}); err != nil {
			return err
		}
		return q.PruneLoginAttempts(ctx, pruneBatch)
	})
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
		Email    string `json:"email"`
		Password string `json:"password"`
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
	user, err := s.findUserByEmail(r.Context(), email)
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
		_ = s.withQueries(r.Context(), func(q *sqlc.Queries) error {
			return s.clearFailure(r.Context(), q, email, ip)
		})
		return authResult(http.StatusUnauthorized, msgDisabled, "AUTH_INVALID")
	}
	token, err := s.sessionToken(r, user.PasswordHash, user.SessionRevision)
	if err != nil {
		return dbResult(err)
	}
	var orgID int64
	err = s.inTx(r.Context(), func(tx pgx.Tx, q *sqlc.Queries) (bool, error) {
		role, err := assertLoginCredential(r.Context(), q, user.ID, user.PasswordHash, user.Email, user.SessionRevision)
		if err != nil {
			return false, err
		}
		user.Role = role
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
		return loginCredentialResult(err)
	}
	res := Result{
		Status:  http.StatusOK,
		Body:    loginBody(token, user.PublicID, user.Role, user.Email, user.Name, user.SupplierID, user.Target),
		Cookies: SessionCookies(token),
	}
	_ = orgID
	return res
}

// Hold the same account lock as password reset and disable until the session
// commits, so a credential checked before either write cannot survive it.
func assertLoginCredential(ctx context.Context, q *sqlc.Queries, userID int64, passwordHash, email string, revision int64) (string, error) {
	current, err := q.AssertPassword(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errDrift
	}
	if err != nil {
		return "", err
	}
	if current.Disabled {
		return "", errDisabled
	}
	if current.PasswordHash != passwordHash || current.SessionRevision != revision || !strings.EqualFold(current.Email, email) {
		return "", errDrift
	}
	return current.Role, nil
}

func loginCredentialResult(err error) Result {
	switch {
	case errors.Is(err, errDrift):
		return authResult(http.StatusUnauthorized, msgCredentialDrift, "AUTH_INVALID")
	case errors.Is(err, errDisabled):
		return authResult(http.StatusUnauthorized, msgDisabled, "AUTH_INVALID")
	default:
		return dbResult(err)
	}
}

func (s *Service) sessionToken(r *http.Request, passwordHash string, revision int64) (string, error) {
	if key := strings.TrimSpace(r.Header.Get("Idempotency-Key")); key != "" {
		return DeriveSessionToken(sessionSeed(passwordHash, revision), key), nil
	}
	return randomToken()
}

func sessionSeed(passwordHash string, revision int64) string {
	return passwordHash + "\x00" + itoa(revision)
}
