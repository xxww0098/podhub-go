package adminrepo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Standing is the super-admin TOTP gate for one session token.
type Standing struct {
	PublicID string
	Enrolled bool
	Elevated bool
}

// LoadStanding reads the account public id, confirmed authenticator, and
// whether this session's step-up is still inside the 15 minute window.
func LoadStanding(ctx context.Context, pool *pgxpool.Pool, userID int64, token string) (Standing, error) {
	if pool == nil || token == "" {
		return Standing{}, nil
	}
	sum := sha256.Sum256([]byte(token))
	var out Standing
	err := pool.QueryRow(ctx, `SELECT u.public_id,
		EXISTS (SELECT 1 FROM account_admin_totp t WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL),
		EXISTS (SELECT 1 FROM account_sessions s WHERE s.user_id = u.id AND s.token_hash = $2 AND s.admin_step_up_until > clock_timestamp())
		FROM account_users u WHERE u.id = $1`, userID, hex.EncodeToString(sum[:])).Scan(&out.PublicID, &out.Enrolled, &out.Elevated)
	if err != nil {
		return Standing{}, err
	}
	return out, nil
}
