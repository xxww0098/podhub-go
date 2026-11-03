package supplierrepo

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	outcome "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	supcontract "github.com/xxww0098/podhub-go/internal/admin/supplier/contract"
)

func (r Portal) ListAccounts(ctx context.Context, actor outcome.Actor) ([]supcontract.Member, error) {
	var out []supcontract.Member
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT m.member_id::text, m.factory_id, s.name, s.country, s.icon,
			       m.status, m.created_at_ms, u.email, u.name, u.public_id
			  FROM sc_factory_members m
			  JOIN sc_factories s ON s.factory_id = m.factory_id
			  JOIN account_users u ON u.id = m.user_id
			 ORDER BY s.name ASC, m.created_at_ms ASC, m.member_id ASC`)
		if err != nil {
			return corerepo.MapDB(err)
		}
		defer rows.Close()
		out = []supcontract.Member{}
		for rows.Next() {
			m, err := scanMember(rows)
			if err != nil {
				return err
			}
			out = append(out, m)
		}
		return corerepo.MapDB(rows.Err())
	})
	return out, err
}

func (r Portal) CreateAccount(ctx context.Context, actor outcome.Actor, in supcontract.NormalizedAccount, nowMs int64, password, passwordHash string) (supcontract.Member, *string, error) {
	var member supcontract.Member
	var initial *string
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		memberID, once, err := provision(ctx, tx, actor, in.FactoryID, in.Email, in.Name, password, passwordHash, "/api/admin/supplier-accounts", nowMs, "新建厂家账号需要超级管理员", "厂家不存在")
		if err != nil {
			return err
		}
		initial = once
		loaded, err := loadMember(ctx, tx, memberID)
		if err != nil {
			return err
		}
		if loaded == nil {
			return corerepo.NotFound("厂家成员不存在")
		}
		member = *loaded
		return nil
	})
	return member, initial, err
}

func (r Portal) PatchAccount(ctx context.Context, actor outcome.Actor, memberID string, in supcontract.AccountPatch, passwordHash string, nowMs int64) (supcontract.Member, *string, error) {
	var member supcontract.Member
	var initial *string
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		loaded, err := loadMember(ctx, tx, memberID)
		if err != nil {
			return err
		}
		if loaded == nil {
			return corerepo.NotFound("厂家成员不存在")
		}
		var userID int64
		if in.Password != nil || in.Status != nil {
			err = tx.QueryRow(ctx, `SELECT user_id FROM sc_factory_members WHERE member_id = $1::uuid FOR UPDATE`, memberID).Scan(&userID)
			if errors.Is(err, pgx.ErrNoRows) {
				return corerepo.NotFound("厂家成员不存在")
			}
			if err != nil {
				return corerepo.MapDB(err)
			}
			if err := lockAccount(ctx, tx, userID); err != nil {
				return err
			}
			loaded, err = loadMember(ctx, tx, memberID)
			if err != nil {
				return err
			}
			if loaded == nil {
				return corerepo.NotFound("厂家成员不存在")
			}
		}
		if in.Status != nil {
			tag, err := tx.Exec(ctx, `UPDATE sc_factory_members SET status = $2 WHERE member_id = $1::uuid`, memberID, *in.Status)
			if err != nil {
				return corerepo.MapDB(err)
			}
			if tag.RowsAffected() == 0 {
				return corerepo.NotFound("厂家成员不存在")
			}
			if *in.Status == "disabled" {
				if err := disableFactorySourceRoles(ctx, tx, loaded.Factory.FactoryID, userID, actor.UserID, nowMs); err != nil {
					return err
				}
			}
		}
		var revoked int64
		if in.Password != nil {
			if err := lockAccount(ctx, tx, userID); err != nil {
				return err
			}
			// Doc §4.2: a super-admin resetting a supplier's password is the same
			// "staff reset" write point as users.SetPassword, so it raises the flag
			// too. Only identity's POST /api/auth/password clears it.
			tag, err := tx.Exec(ctx, `UPDATE account_users SET password_hash = $1, must_change_password = true, updated_at = clock_timestamp() WHERE id = $2`, passwordHash, userID)
			if err != nil {
				return corerepo.MapDB(err)
			}
			if tag.RowsAffected() != 1 {
				return corerepo.Internal()
			}
			tag, err = tx.Exec(ctx, `DELETE FROM account_sessions WHERE user_id = $1`, userID)
			if err != nil {
				return corerepo.MapDB(err)
			}
			revoked = tag.RowsAffected()
			initial = in.Password
		}
		var statusSet *string
		if in.Status != nil {
			statusSet = in.Status
		}
		if err := corerepo.Audit(ctx, tx, actor, "supplier_portal", "supplier_account", memberID, "PATCH", "/api/admin/supplier-accounts/{member_id}", "supplier_account_updated", corecontract.JSONText(struct {
			StatusSet       *string `json:"statusSet"`
			PasswordReset   bool    `json:"passwordReset"`
			SessionsRevoked int64   `json:"sessionsRevoked"`
		}{statusSet, in.Password != nil, revoked})); err != nil {
			return err
		}
		loaded, err = loadMember(ctx, tx, memberID)
		if err != nil {
			return err
		}
		if loaded == nil {
			return corerepo.NotFound("厂家成员不存在")
		}
		member = *loaded
		return nil
	})
	return member, initial, err
}

func (r Portal) DeleteAccount(ctx context.Context, actor outcome.Actor, memberID string, nowMs int64) error {
	return r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		var userID int64
		var factoryID string
		err := tx.QueryRow(ctx, `DELETE FROM sc_factory_members WHERE member_id = $1::uuid RETURNING user_id, factory_id`, memberID).Scan(&userID, &factoryID)
		if errors.Is(err, pgx.ErrNoRows) {
			return corerepo.NotFound("厂家成员不存在")
		}
		if err != nil {
			return corerepo.MapDB(err)
		}
		if err := disableFactorySourceRoles(ctx, tx, factoryID, userID, actor.UserID, nowMs); err != nil {
			return err
		}
		return corerepo.Audit(ctx, tx, actor, "supplier_portal", "supplier_account", memberID, "DELETE", "/api/admin/supplier-accounts/{member_id}", "supplier_account_unbound", `{}`)
	})
}

func (r Portal) AccountStaff(ctx context.Context, userID int64) (bool, bool, error) {
	var found, staff bool
	err := r.withTx(ctx, 0, func(tx pgx.Tx) error {
		var role string
		err := tx.QueryRow(ctx, `
			SELECT role FROM account_users
			 WHERE id = $1 AND disabled_at IS NULL`, userID).Scan(&role)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return corerepo.MapDB(err)
		}
		found = true
		staff = role == "admin" || role == "super_admin"
		return nil
	})
	return found, staff, err
}

func provision(ctx context.Context, tx pgx.Tx, actor outcome.Actor, factoryID, email string, name *string, password, passwordHash, auditPath string, nowMs int64, superMessage, missing string) (string, *string, error) {
	if actor.Role != "super_admin" {
		return "", nil, corerepo.Forbidden(superMessage)
	}
	var one int
	err := tx.QueryRow(ctx, `SELECT 1 FROM sc_factories WHERE factory_id = $1 LIMIT 1`, factoryID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, corerepo.NotFound(missing)
	}
	if err != nil {
		return "", nil, corerepo.MapDB(err)
	}
	var userID int64
	var role, accountKind string
	var disabled bool
	err = tx.QueryRow(ctx, `
		SELECT id::bigint, role, disabled_at IS NOT NULL, account_kind
		  FROM account_users
		 WHERE lower(email) = $1
		 ORDER BY (email = $1) DESC
		 LIMIT 1`, email).Scan(&userID, &role, &disabled, &accountKind)
	var initial *string
	if errors.Is(err, pgx.ErrNoRows) {
		if len(password) > 72 {
			return "", nil, &outcome.Fail{Kind: outcome.KindValidation, Message: "密码过长"}
		}
		display := emailLocal(email)
		if name != nil && strings.TrimSpace(*name) != "" {
			display = strings.TrimSpace(*name)
		}
		publicID, herr := corecontract.NewPublicID()
		if herr != nil {
			return "", nil, corerepo.Internal()
		}
		err = tx.QueryRow(ctx, `
			INSERT INTO account_users
			       (public_id, email, password_hash, role, name, target, supplier_id, plan,
			        account_kind, must_change_password, created_at, updated_at)
			VALUES ($1, $2, $3, 'user', $4, '/supplier', '', 'free', 'supplier', true,
			        clock_timestamp(), clock_timestamp())
			RETURNING id::bigint`, publicID, email, passwordHash, display).Scan(&userID)
		if corerepo.Constraint(err) != "" {
			return "", nil, corerepo.Conflict("邮箱已注册")
		}
		if err != nil {
			return "", nil, corerepo.MapDB(err)
		}
		initial = &password
	} else if err != nil {
		return "", nil, corerepo.MapDB(err)
	} else {
		if accountKind == "platform" {
			return "", nil, corerepo.Conflict("该邮箱已是平台账号，不能绑定为厂家成员")
		}
		if role != "user" {
			return "", nil, corerepo.Conflict("不能绑定管理员邮箱")
		}
		if disabled {
			return "", nil, corerepo.Conflict("该邮箱的账号已停用")
		}
	}
	var memberID string
	err = tx.QueryRow(ctx, `
		INSERT INTO sc_factory_members (factory_id, user_id, created_by, created_at_ms)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (factory_id, user_id) DO NOTHING
		RETURNING member_id::text`, factoryID, userID, actor.UserID, nowMs).Scan(&memberID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, corerepo.Conflict("该邮箱已是这家厂家的成员")
	}
	if err != nil {
		return "", nil, corerepo.MapDB(err)
	}
	createdUser := initial != nil
	if err := corerepo.Audit(ctx, tx, actor, "supplier_portal", "supplier_account", memberID, "POST", auditPath, "supplier_account_created", corecontract.JSONText(struct {
		FactoryID   string `json:"factoryId"`
		Email       string `json:"email"`
		CreatedUser bool   `json:"createdUser"`
	}{factoryID, email, createdUser})); err != nil {
		return "", nil, err
	}
	return memberID, initial, nil
}

func loadMember(ctx context.Context, tx pgx.Tx, memberID string) (*supcontract.Member, error) {
	rows, err := tx.Query(ctx, `
		SELECT m.member_id::text, m.factory_id, s.name, s.country, s.icon,
		       m.status, m.created_at_ms, u.email, u.name, u.public_id
		  FROM sc_factory_members m
		  JOIN sc_factories s ON s.factory_id = m.factory_id
		  JOIN account_users u ON u.id = m.user_id
		 WHERE m.member_id = $1::uuid`, memberID)
	if err != nil {
		return nil, corerepo.MapDB(err)
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, corerepo.MapDB(rows.Err())
	}
	m, err := scanMember(rows)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanMember(rows rowScanner) (supcontract.Member, error) {
	var m supcontract.Member
	var name string
	if err := rows.Scan(&m.MemberID, &m.Factory.FactoryID, &m.Factory.Name, &m.Factory.Country, &m.Factory.Icon, &m.Status, &m.CreatedAtMs, &m.Email, &name, &m.AccountUUID); err != nil {
		return supcontract.Member{}, corerepo.MapDB(err)
	}
	if strings.TrimSpace(name) != "" {
		m.Name = &name
	}
	return m, nil
}

func lockAccount(ctx context.Context, tx pgx.Tx, userID int64) error {
	var id int64
	err := tx.QueryRow(ctx, `SELECT id FROM account_users WHERE id = $1 FOR NO KEY UPDATE`, userID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return corerepo.NotFound("厂家成员不存在")
	}
	return corerepo.MapDB(err)
}

func emailLocal(email string) string {
	local, _, _ := strings.Cut(email, "@")
	if local == "" {
		return email
	}
	return local
}
