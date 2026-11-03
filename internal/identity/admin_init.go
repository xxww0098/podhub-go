package identity

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

var ErrAdminInitialized = errors.New("平台已初始化，不会覆盖管理员账号或密码")

// AdminInitialized also refuses to replace an owner whose initialization marker is missing.
func (s *Service) AdminInitialized(ctx context.Context) (bool, error) {
	var initialized bool
	err := db.InTx(ctx, s.pool, db.AppRole(), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT
			EXISTS (SELECT 1 FROM platform_initialization WHERE owner_account_id IS NOT NULL)
			OR EXISTS (SELECT 1 FROM account_users WHERE lower(btrim(role)) = 'super_admin')`).Scan(&initialized)
	})
	return initialized, err
}

// InitializeAdmin is an operator-only entry point; it is never mounted as an HTTP route.
func (s *Service) InitializeAdmin(ctx context.Context, email, password string) error {
	email = strings.TrimSpace(email)
	if !EmailShaped(email) || utf8.RuneCountInString(email) > 320 {
		return errors.New("邮箱格式无效")
	}
	if utf8.RuneCountInString(password) < 8 || len(password) > maxPasswordBytes {
		return errors.New(msgPasswordBounds)
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	publicID, err := newPublicID()
	if err != nil {
		return err
	}
	return db.InTx(ctx, s.pool, db.AppRole(), func(tx pgx.Tx) error {
		var initialized bool
		if err := tx.QueryRow(ctx, `SELECT owner_account_id IS NOT NULL
			FROM platform_initialization WHERE singleton FOR UPDATE`).Scan(&initialized); err != nil {
			return err
		}
		if initialized {
			return ErrAdminInitialized
		}
		if err := tx.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM account_users WHERE lower(btrim(role)) = 'super_admin')`).Scan(&initialized); err != nil {
			return err
		}
		if initialized {
			return ErrAdminInitialized
		}
		var userID int64
		if err := tx.QueryRow(ctx, `INSERT INTO account_users
			(public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
			VALUES ($1, $2, $3, 'super_admin', '超级管理员', '/admin', '', 'free', clock_timestamp(), clock_timestamp())
			RETURNING id`, publicID, email, hash).Scan(&userID); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return errors.New("账号已存在，不能覆盖或提升已有账号")
			}
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE platform_initialization
			SET owner_account_id = $1, initialized_at = clock_timestamp() WHERE singleton`, userID); err != nil {
			return err
		}
		return sqlc.New(tx).InsertAudit(ctx, sqlc.InsertAuditParams{
			OrgID: 0, UserID: userID, Module: "auth", EntityType: "account", EntityID: publicID,
			ApiMethod: "CLI", ApiPath: "admin-init", Action: "platform_initialized",
			Message: `{"summary":"初始化超级管理员"}`,
		})
	})
}
