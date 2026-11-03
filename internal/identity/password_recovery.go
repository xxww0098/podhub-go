package identity

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

const recoveryAAD = "podhub:password-reset-mail:v1:"

func recoveryIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return "direct"
	}
	// Only the local reverse proxy may supply a forwarded address.
	if ip.IsLoopback() {
		if forwarded := ClientIP(r.Header); forwarded != "direct" {
			return forwarded
		}
	}
	return ip.String()
}

func (s *Service) forgot(r *http.Request, email string) Result {
	email = strings.TrimSpace(email)
	if !EmailShaped(email) || len(email) > 320 {
		return authResult(http.StatusBadRequest, "邮箱格式无效", "VALIDATION")
	}
	if s.resetMailer == nil || len(s.resetKey) != 32 || s.pool == nil {
		return authResult(http.StatusServiceUnavailable, "邮件找回暂不可用，请稍后重试或联系管理员", "UNAVAILABLE")
	}
	// IP admission is independent of account existence and persists across restarts.
	sum := sha256.Sum256([]byte(recoveryIP(r)))
	var admitted sqlc.BumpResetRequestRow
	err := s.withQueries(r.Context(), func(q *sqlc.Queries) error {
		if err := q.PruneResetRequests(r.Context()); err != nil {
			return err
		}
		var err error
		admitted, err = q.BumpResetRequest(r.Context(), hex.EncodeToString(sum[:]))
		return err
	})
	if err != nil {
		return dbResult(err)
	}
	if admitted.Requests > 5 {
		res := authResult(http.StatusTooManyRequests, msgBusyHash, "RATE_LIMITED")
		res.RetryAfter = strconv.Itoa(int(admitted.RetryAfter))
		return res
	}
	// Generate and encrypt before account lookup; no raw token enters the database.
	token, err := randomToken()
	if err != nil {
		return dbResult(err)
	}
	digest := hashToken(token)
	nonce, ciphertext, err := seal.SealBlob(s.resetKey, recoveryAAD+digest, []byte(token))
	if err != nil {
		return dbResult(err)
	}
	err = s.inTx(r.Context(), func(_ pgx.Tx, q *sqlc.Queries) (bool, error) {
		user, err := q.FindUserByEmail(r.Context(), email)
		if errors.Is(err, pgx.ErrNoRows) {
			return true, nil
		}
		if err != nil {
			return false, err
		}
		state, err := q.LockUserState(r.Context(), user.ID)
		if err != nil {
			return false, err
		}
		// Recheck after acquiring the user lock: the address may have changed.
		if state.Disabled || !strings.EqualFold(state.Email, email) {
			return true, nil
		}
		recent, err := q.RecentResetRequest(r.Context(), user.ID)
		if err != nil {
			return false, err
		}
		if recent {
			return true, nil
		}
		if err = q.InsertResetToken(r.Context(), sqlc.InsertResetTokenParams{TokenHash: digest, UserID: user.ID}); err != nil {
			return false, err
		}
		if err = q.InsertResetDelivery(r.Context(), sqlc.InsertResetDeliveryParams{TokenHash: digest, SecretNonce: nonce, SecretCiphertext: ciphertext}); err != nil {
			return false, err
		}
		return true, q.InsertAudit(r.Context(), sqlc.InsertAuditParams{OrgID: 0, UserID: user.ID, Module: "auth", EntityType: "account", EntityID: user.PublicID, ApiMethod: "POST", ApiPath: "/api/auth/forgot", Action: "password_reset_requested", Message: `{"summary":"申请找回密码"}`})
	})
	if err != nil {
		return dbResult(err)
	}
	return Result{Status: http.StatusOK, Body: []byte(`{"data":{"ok":true}}`)}
}

// DeliverPasswordResets claims a bounded batch, then releases all database
// connections before external delivery. Expired leases make crash recovery safe.
// SMTP acceptance can be repeated after an ambiguous network failure; the same
// token is reused and can change a password only once.
func (s *Service) DeliverPasswordResets(ctx context.Context, limit int) (int, error) {
	if s.resetMailer == nil || len(s.resetKey) != 32 || s.pool == nil {
		return 0, nil
	}
	if limit < 1 {
		return 0, nil
	}
	if limit > 4 {
		limit = 4
	}
	lease, err := randomToken()
	if err != nil {
		return 0, err
	}
	claim := pgtype.Text{String: lease, Valid: true}
	var rows []sqlc.ClaimResetDeliveriesRow
	// Cleanup follows the same user→token→delivery order as credential writes,
	// and commits before any claim can hold a delivery lock.
	if err = s.withQueries(ctx, func(q *sqlc.Queries) error { return q.PruneResetTokens(ctx) }); err != nil {
		return 0, err
	}
	err = s.withQueries(ctx, func(q *sqlc.Queries) error {
		if err := q.ExpireResetDeliveries(ctx); err != nil {
			return err
		}
		var err error
		rows, err = q.ClaimResetDeliveries(ctx, sqlc.ClaimResetDeliveriesParams{Limit: int32(limit), LeaseToken: claim})
		return err
	})
	if err != nil {
		return 0, err
	}
	processed := 0
	for _, row := range rows {
		if err := ctx.Err(); err != nil {
			return processed, err
		}
		var recipient sqlc.ResetDeliveryRecipientRow
		err = s.withQueries(ctx, func(q *sqlc.Queries) error {
			var err error
			recipient, err = q.ResetDeliveryRecipient(ctx, sqlc.ResetDeliveryRecipientParams{TokenHash: row.TokenHash, LeaseToken: claim})
			return err
		})
		state, code := "sent", ""
		if errors.Is(err, pgx.ErrNoRows) {
			state, code = "cancelled", "invalid_token"
		} else if err != nil {
			return processed, err
		}
		if state == "sent" {
			token, openErr := seal.OpenBlob(s.resetKey, recoveryAAD+row.TokenHash, row.SecretNonce, row.SecretCiphertext)
			if openErr != nil || !IsSessionToken(string(token)) || hashToken(string(token)) != row.TokenHash {
				state, code = "failed", "invalid_payload"
			} else {
				deliveryCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
				var sendErr error
				if recipient.Purpose == "change_email" {
					if s.emailChangeMailer == nil {
						sendErr = errors.New("email change mailer unavailable")
					} else {
						sendErr = s.emailChangeMailer.SendEmailChange(deliveryCtx, recipient.Email, string(token))
					}
				} else {
					sendErr = s.resetMailer.SendPasswordReset(deliveryCtx, recipient.Email, string(token))
				}
				cancel()
				if sendErr != nil {
					state, code = "pending", "temporary"
					if errors.Is(sendErr, ErrResetMailRejected) {
						state, code = "failed", "rejected"
					} else if row.Attempts >= 5 {
						state, code = "failed", "exhausted"
					}
				}
			}
		}
		if err := ctx.Err(); err != nil {
			return processed, err
		}
		delay := int32(60) << uint(row.Attempts-1)
		err = s.withQueries(ctx, func(q *sqlc.Queries) error {
			_, err := q.FinishResetDelivery(ctx, sqlc.FinishResetDeliveryParams{State: state, ErrorCode: code, DelaySeconds: delay, TokenHash: row.TokenHash, LeaseToken: claim})
			return err
		})
		if err != nil {
			return processed, err
		}
		if state == "pending" || state == "failed" {
			slog.Warn("password recovery mail delivery", "state", state, "reason", code, "attempt", row.Attempts)
		}
		processed++
	}
	return processed, nil
}
