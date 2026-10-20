package adminrepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// Standing is enrolled and elevated for one live session.
func (s *Store) Standing(ctx context.Context, tokenHash string, userID int64) (bool, bool, *contract.Fault) {
	var enrolled, elevated bool
	err := s.pool.QueryRow(ctx, `
SELECT (t.confirmed_at IS NOT NULL) AS enrolled,
       COALESCE(s.admin_step_up_until > clock_timestamp(), false) AS elevated
FROM account_sessions s
LEFT JOIN account_admin_totp t ON t.user_id = s.user_id
WHERE s.token_hash = $1 AND s.user_id = $2 AND s.expires_at > clock_timestamp()`, tokenHash, userID).Scan(&enrolled, &elevated)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, false, contract.Internal("服务暂不可用")
	}
	if err != nil {
		return false, false, dbFault(err)
	}
	return enrolled, elevated, nil
}

// LoadTotp reads the verifier without a lock. Missing is a nil row and a nil fault.
func (s *Store) LoadTotp(ctx context.Context, userID int64) (*domain.TotpRow, *contract.Fault) {
	row, err := s.readTotp(ctx, s.pool, userID, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, dbFault(err)
	}
	return row, nil
}

type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func (s *Store) readTotp(ctx context.Context, q querier, userID int64, lock bool) (*domain.TotpRow, error) {
	sql := `
SELECT secret_nonce, secret_ciphertext, confirmed_at IS NOT NULL,
       failed_attempts, failures_reset_at
FROM account_admin_totp WHERE user_id = $1`
	if lock {
		sql += ` FOR UPDATE`
	}
	var row domain.TotpRow
	var confirmed bool
	err := q.QueryRow(ctx, sql, userID).Scan(&row.Nonce, &row.Cipher, &confirmed, &row.Failed, &row.ResetAt)
	if err != nil {
		return nil, err
	}
	row.Confirmed = confirmed
	return &row, nil
}

// VerifyTotp locks the row, applies the match, and commits even when the code is wrong.
// The result is missing, locked, ok, or bad.
func (s *Store) VerifyTotp(ctx context.Context, userID int64, now time.Time, key []byte, code string) (string, *contract.Fault) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", dbFault(err)
	}
	defer tx.Rollback(ctx)
	defer endLease(tx)
	row, err := s.readTotp(ctx, tx, userID, true)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.Commit(ctx); err != nil {
			return "", dbFault(err)
		}
		return "missing", nil
	}
	if err != nil {
		return "", dbFault(err)
	}
	if row.Failed >= 5 && row.ResetAt != nil && row.ResetAt.Add(15*time.Minute).After(now) {
		if err := tx.Commit(ctx); err != nil {
			return "", dbFault(err)
		}
		return "locked", nil
	}
	secret, err := domain.Open(key, []byte("admin_totp|v1|"+itoa(userID)), row.Nonce, row.Cipher)
	totpOK := err == nil && domain.TotpMatches(secret, code, now)
	if totpOK {
		if _, err := tx.Exec(ctx, `
UPDATE account_admin_totp
SET failed_attempts = 0, failures_reset_at = NULL, updated_at = clock_timestamp()
WHERE user_id = $1`, userID); err != nil {
			return "", dbFault(err)
		}
		if err := tx.Commit(ctx); err != nil {
			return "", dbFault(err)
		}
		return "ok", nil
	}
	hash := domain.HashRecovery(code)
	tag, err := tx.Exec(ctx, `
UPDATE account_admin_totp
SET recovery_hashes = array_remove(recovery_hashes, $2),
    failed_attempts = 0, failures_reset_at = NULL, updated_at = clock_timestamp()
WHERE user_id = $1 AND $2 = ANY(recovery_hashes)`, userID, hash)
	if err != nil {
		return "", dbFault(err)
	}
	if tag.RowsAffected() == 1 {
		if err := tx.Commit(ctx); err != nil {
			return "", dbFault(err)
		}
		return "ok", nil
	}
	if _, err := tx.Exec(ctx, `
UPDATE account_admin_totp
SET failed_attempts = CASE
        WHEN failures_reset_at IS NULL
          OR failures_reset_at + ($2::bigint * interval '1 second') <= statement_timestamp()
        THEN 1
        ELSE LEAST(failed_attempts, $3 - 1) + 1
    END,
    failures_reset_at = CASE
        WHEN failed_attempts = 0 OR failures_reset_at IS NULL
          OR failures_reset_at + ($2::bigint * interval '1 second') <= statement_timestamp()
        THEN statement_timestamp()
        ELSE failures_reset_at
    END,
    updated_at = statement_timestamp()
WHERE user_id = $1`, userID, int64(900), 5); err != nil {
		return "", dbFault(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", dbFault(err)
	}
	return "bad", nil
}

// EnrollTotp upserts an unconfirmed verifier inside the auth writer gate.
func (s *Store) EnrollTotp(ctx context.Context, actor domain.Actor, nonce, cipher []byte, hashes []string) *contract.Fault {
	return s.withGate(ctx, "auth", "认证域写入未启用", func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
INSERT INTO account_admin_totp
    (user_id, secret_nonce, secret_ciphertext, recovery_hashes)
VALUES ($1, $2, $3, $4)
ON CONFLICT (user_id) DO UPDATE SET
    secret_nonce = EXCLUDED.secret_nonce,
    secret_ciphertext = EXCLUDED.secret_ciphertext,
    recovery_hashes = EXCLUDED.recovery_hashes,
    confirmed_at = NULL,
    failed_attempts = 0,
    failures_reset_at = NULL,
    updated_at = clock_timestamp()
WHERE account_admin_totp.confirmed_at IS NULL`, actor.ID, nonce, cipher, hashes)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return errors.New("admin totp already confirmed")
		}
		return writeAudit(ctx, tx, auditRow{
			OrgID: actor.OrgID, UserID: actor.ID, Module: "admin", EntityType: "account",
			EntityID: itoa(actor.ID), Method: "POST", Path: "/api/admin/totp/enroll",
			Action: "admin_totp_enrolled", Message: `{"summary":"开始绑定管理验证器"}`,
		})
	})
}

// ConfirmTotp stamps confirmed_at and the step-up window inside the auth gate.
func (s *Store) ConfirmTotp(ctx context.Context, actor domain.Actor, until time.Time) *contract.Fault {
	return s.withGate(ctx, "auth", "认证域写入未启用", func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
UPDATE account_admin_totp
SET confirmed_at = clock_timestamp(), updated_at = clock_timestamp()
WHERE user_id = $1`, actor.ID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE account_sessions SET admin_step_up_until = $2 WHERE token_hash = $1`, actor.TokenHash, until); err != nil {
			return err
		}
		return writeAudit(ctx, tx, auditRow{
			OrgID: actor.OrgID, UserID: actor.ID, Module: "admin", EntityType: "account",
			EntityID: itoa(actor.ID), Method: "POST", Path: "/api/admin/totp/confirm",
			Action: "admin_totp_confirmed", Message: `{"summary":"确认管理验证器"}`,
		})
	})
}

// StepUp stamps the step-up window and does not change confirmed_at.
func (s *Store) StepUp(ctx context.Context, actor domain.Actor, until time.Time) *contract.Fault {
	return s.withGate(ctx, "auth", "认证域写入未启用", func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE account_sessions SET admin_step_up_until = $2 WHERE token_hash = $1`, actor.TokenHash, until); err != nil {
			return err
		}
		return writeAudit(ctx, tx, auditRow{
			OrgID: actor.OrgID, UserID: actor.ID, Module: "admin", EntityType: "account",
			EntityID: itoa(actor.ID), Method: "POST", Path: "/api/admin/step-up",
			Action: "admin_step_up", Message: `{"summary":"重新验证管理操作"}`,
		})
	})
}

func itoa(n int64) string {
	return fmtInt(n)
}

func fmtInt(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
