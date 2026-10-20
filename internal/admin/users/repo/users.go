package usersrepo

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	contract "github.com/xxww0098/podhub-go/internal/admin/core/contract/apifault"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	userscontract "github.com/xxww0098/podhub-go/internal/admin/users/contract"
	"github.com/xxww0098/podhub-go/internal/admin/users/domain"
)

const accountProjection = `
SELECT u.id, u.public_id, u.email, u.role, p.name, u.plan,
       u.disabled_at IS NOT NULL AS disabled,
       to_char(u.created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
       o.id AS org_id, o.plan AS org_plan, o.seat_limit,
       COALESCE(seats.used, 0) AS seats_used,
       COALESCE(tokens.used, 0) AS ai_tokens_used,
       COALESCE(pl.ai_tokens_monthly, 0) AS ai_tokens_monthly
FROM account_users u
JOIN account_profiles p ON p.user_id = u.id
LEFT JOIN LATERAL (
    SELECT t.id, t.plan, t.seat_limit
    FROM organization_members om
    JOIN organizations t ON t.id = om.org_id
    WHERE om.user_id = u.id
      AND om.role = 'owner'
      AND t.dissolved_at IS NULL
    ORDER BY t.id ASC
    LIMIT 1
) o ON true
LEFT JOIN plans pl
    ON pl.active = true
   AND pl.key = COALESCE(NULLIF(TRIM(o.plan), ''), u.plan)
LEFT JOIN LATERAL (
    SELECT COUNT(*)::bigint AS used
    FROM organization_members m
    WHERE m.org_id = o.id
      AND m.status = 'active'
      AND NOT m.manual_disabled
      AND NOT m.quota_suspended
) seats ON true
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(r.total), 0)::bigint AS used
    FROM billable_usage_rollups r
    WHERE r.org_id = o.id
      AND r.billing_period = to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), 'YYYY-MM')
      AND r.metric IN ('ai.input_tokens', 'ai.output_tokens')
) tokens ON true
`

func scanAccount(row pgx.Row) (userscontract.Account, error) {
	var a userscontract.Account
	var orgID *int64
	var orgPlan *string
	var seat *int64
	err := row.Scan(&a.ID, &a.PublicID, &a.Email, &a.Role, &a.Name, &a.Plan,
		&a.Disabled, &a.CreatedAt, &orgID, &orgPlan, &seat,
		&a.SeatsUsed, &a.TokensUsed, &a.TokensMonthly)
	if err != nil {
		return userscontract.Account{}, err
	}
	a.OrgID = orgID
	if orgPlan != nil {
		a.OrgPlan = *orgPlan
	}
	if seat != nil {
		a.SeatLimit = *seat
	}
	return a, nil
}

func (s *Users) LoadByPublicID(ctx context.Context, tx pgx.Tx, publicID string) (userscontract.Account, error) {
	row := tx.QueryRow(ctx, accountProjection+` WHERE u.public_id = $1 LIMIT 1`, publicID)
	a, err := scanAccount(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return userscontract.Account{}, contract.Validation("用户不存在")
	}
	return a, err
}

// ReadAccount loads one public id outside a writer gate.
func (s *Users) ReadAccount(ctx context.Context, publicID string) (userscontract.Account, *contract.Fault) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return userscontract.Account{}, corerepo.DBFault(err)
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	account, err := s.LoadByPublicID(ctx, tx, publicID)
	if err != nil {
		return userscontract.Account{}, corerepo.PlainFault(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return userscontract.Account{}, corerepo.DBFault(err)
	}
	return account, nil
}

func (s *Users) LoadByID(ctx context.Context, tx pgx.Tx, id int64) (userscontract.Account, error) {
	row := tx.QueryRow(ctx, accountProjection+` WHERE u.id = $1 LIMIT 1`, id)
	a, err := scanAccount(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return userscontract.Account{}, contract.NotFound("用户不存在")
	}
	return a, err
}

func (s *Users) lastSuper(ctx context.Context, tx pgx.Tx) (bool, error) {
	rows, err := tx.Query(ctx, `
SELECT id FROM account_users
 WHERE role = 'super_admin' AND disabled_at IS NULL
 FOR UPDATE`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return false, err
		}
		n++
	}
	return n == 1, rows.Err()
}

// ListDirectory reads the three directory queries and owner wallets, commits,
// then writes accounts_listed. Audit failure is returned after the directory
// commit.
func (s *Users) ListDirectory(ctx context.Context, actor corecontract.Actor) (userscontract.Directory, *contract.Fault) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return userscontract.Directory{}, corerepo.DBFault(err)
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	wsRows, err := tx.Query(ctx, `
SELECT o.id,
       lower(o.uuid::text) AS uuid,
       o.name, o.plan, o.seat_limit,
       o.owner_user_id,
       u.public_id AS owner_uuid,
       to_char(o.created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
       COALESCE(seats.used, 0) AS seats_used,
       COALESCE(tokens.used, 0) AS ai_tokens_used,
       COALESCE(pl.ai_tokens_monthly, 0) AS ai_tokens_monthly
FROM organizations o
JOIN account_users u ON u.id = o.owner_user_id
LEFT JOIN plans pl ON pl.active = true AND pl.key = o.plan
LEFT JOIN LATERAL (
    SELECT COUNT(*)::bigint AS used
    FROM organization_members m
    WHERE m.org_id = o.id
      AND m.status = 'active'
      AND NOT m.manual_disabled
      AND NOT m.quota_suspended
) seats ON true
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(r.total), 0)::bigint AS used
    FROM billable_usage_rollups r
    WHERE r.org_id = o.id
      AND r.billing_period = to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), 'YYYY-MM')
      AND r.metric IN ('ai.input_tokens', 'ai.output_tokens')
) tokens ON true
WHERE o.dissolved_at IS NULL
ORDER BY o.id ASC`)
	if err != nil {
		return userscontract.Directory{}, corerepo.DBFault(err)
	}
	var spaces []userscontract.Workspace
	for wsRows.Next() {
		var w userscontract.Workspace
		if err := wsRows.Scan(&w.ID, &w.UUID, &w.Name, &w.Plan, &w.SeatLimit, &w.OwnerID, &w.OwnerUUID, &w.CreatedAt, &w.SeatsUsed, &w.TokensUsed, &w.TokensMonthly); err != nil {
			wsRows.Close()
			return userscontract.Directory{}, corerepo.DBFault(err)
		}
		spaces = append(spaces, w)
	}
	if err := wsRows.Err(); err != nil {
		wsRows.Close()
		return userscontract.Directory{}, corerepo.DBFault(err)
	}
	wsRows.Close()

	memRows, err := tx.Query(ctx, `
SELECT m.org_id, m.user_id, m.role AS membership_role,
       m.manual_disabled, m.quota_suspended,
       u.public_id, u.email, u.role, p.name,
       u.disabled_at IS NOT NULL AS disabled,
       to_char(u.created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
       COALESCE(to_char(u.last_login_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') AS last_login_at
FROM organization_members m
JOIN account_users u ON u.id = m.user_id
JOIN account_profiles p ON p.user_id = u.id
WHERE m.status = 'active'
ORDER BY m.org_id ASC, m.join_order ASC, m.id ASC`)
	if err != nil {
		return userscontract.Directory{}, corerepo.DBFault(err)
	}
	byOrg := map[int64][]userscontract.Person{}
	seen := map[string]struct{}{}
	for memRows.Next() {
		var orgID int64
		var p userscontract.Person
		if err := memRows.Scan(&orgID, &p.UserID, &p.MembershipRole, &p.Manual, &p.Quota, &p.PublicID, &p.Email, &p.Role, &p.Name, &p.Disabled, &p.CreatedAt, &p.LastLogin); err != nil {
			memRows.Close()
			return userscontract.Directory{}, corerepo.DBFault(err)
		}
		p.HasMembership = true
		byOrg[orgID] = append(byOrg[orgID], p)
		seen[p.PublicID] = struct{}{}
	}
	if err := memRows.Err(); err != nil {
		memRows.Close()
		return userscontract.Directory{}, corerepo.DBFault(err)
	}
	memRows.Close()

	unRows, err := tx.Query(ctx, `
SELECT u.id, u.public_id, u.email, u.role, p.name,
       u.disabled_at IS NOT NULL AS disabled,
       to_char(u.created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
       COALESCE(to_char(u.last_login_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') AS last_login_at
FROM account_users u
JOIN account_profiles p ON p.user_id = u.id
WHERE NOT EXISTS (
    SELECT 1 FROM organization_members m
    WHERE m.user_id = u.id AND m.status = 'active'
)
ORDER BY u.id ASC`)
	if err != nil {
		return userscontract.Directory{}, corerepo.DBFault(err)
	}
	var unaffiliated []userscontract.Person
	for unRows.Next() {
		var p userscontract.Person
		if err := unRows.Scan(&p.UserID, &p.PublicID, &p.Email, &p.Role, &p.Name, &p.Disabled, &p.CreatedAt, &p.LastLogin); err != nil {
			unRows.Close()
			return userscontract.Directory{}, corerepo.DBFault(err)
		}
		unaffiliated = append(unaffiliated, p)
		seen[p.PublicID] = struct{}{}
	}
	if err := unRows.Err(); err != nil {
		unRows.Close()
		return userscontract.Directory{}, corerepo.DBFault(err)
	}
	unRows.Close()

	wallets := map[int64][2]int64{}
	for i := range spaces {
		owner := spaces[i].OwnerID
		bal, ok := wallets[owner]
		if !ok {
			if _, err := tx.Exec(ctx, `SELECT set_config('app.current_wallet_user_id', $1, true)`, fmt.Sprint(owner)); err != nil {
				return userscontract.Directory{}, corerepo.DBFault(err)
			}
			var balance, held int64
			err := tx.QueryRow(ctx, `SELECT balance_microfen, held_microfen FROM user_wallets WHERE user_id = $1`, owner).Scan(&balance, &held)
			if errors.Is(err, pgx.ErrNoRows) {
				balance, held = 0, 0
			} else if err != nil {
				return userscontract.Directory{}, corerepo.DBFault(err)
			}
			if held > balance {
				bal = [2]int64{0, held}
			} else {
				bal = [2]int64{balance - held, held}
			}
			wallets[owner] = bal
		}
		spaces[i].Available = bal[0]
		spaces[i].Held = bal[1]
		spaces[i].Members = byOrg[spaces[i].ID]
		if spaces[i].Members == nil {
			spaces[i].Members = []userscontract.Person{}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return userscontract.Directory{}, corerepo.DBFault(err)
	}
	dir := userscontract.Directory{Workspaces: spaces, Unaffiliated: unaffiliated, UserCount: len(seen)}
	if dir.Workspaces == nil {
		dir.Workspaces = []userscontract.Workspace{}
	}
	if dir.Unaffiliated == nil {
		dir.Unaffiliated = []userscontract.Person{}
	}
	msg := corerepo.JSONText(struct {
		Summary        string `json:"summary"`
		WorkspaceCount int    `json:"workspace_count"`
		UserCount      int    `json:"user_count"`
	}{
		Summary:        fmt.Sprintf("列出工作空间 %d 个，账号 %d 条", len(dir.Workspaces), dir.UserCount),
		WorkspaceCount: len(dir.Workspaces),
		UserCount:      dir.UserCount,
	})
	if err := s.auditAfter(ctx, corerepo.AuditRow{
		OrgID: corerepo.OrgFloor(actor.OrgID), UserID: actor.ID, Module: "admin",
		EntityType: "account", EntityID: "*", Method: "GET", Path: "/api/admin/users",
		Action: "accounts_listed", Message: msg,
	}); err != nil {
		return userscontract.Directory{}, corerepo.DBFault(err)
	}
	return dir, nil
}

// CreateUser inserts the account, bootstraps the owner org, binds invitations,
// and audits inside the admin writer gate.
func (s *Users) CreateUser(ctx context.Context, actor corecontract.Actor, publicID, email, name, role, hash string) (userscontract.Account, int64, *contract.Fault) {
	var created userscontract.Account
	var orgID int64
	fault := s.withGate(ctx, "admin", "管理域写入未启用", func(ctx context.Context, tx pgx.Tx) error {
		row := tx.QueryRow(ctx, `
INSERT INTO account_users
       (public_id, email, password_hash, role, name, target, supplier_id, plan,
        created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, '/workspace', '', 'lite',
        clock_timestamp(), clock_timestamp())
ON CONFLICT (email) DO NOTHING
RETURNING id`, publicID, email, hash, role, name)
		var id int64
		if err := row.Scan(&id); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return contract.Conflict("邮箱已注册")
			}
			return err
		}
		var err error
		orgID, err = s.bootstrap(ctx, tx, id, email, name)
		if err != nil {
			return err
		}
		bound, err := s.bindInvites(ctx, tx, id, email)
		if err != nil {
			return err
		}
		created, err = s.LoadByID(ctx, tx, id)
		if err != nil {
			return err
		}
		msg := corerepo.JSONText(struct {
			Summary            string `json:"summary"`
			TargetUUID         string `json:"target_uuid"`
			WorkspaceID        int64  `json:"workspace_id"`
			PendingInvitations int64  `json:"pending_invitations"`
		}{
			Summary:            fmt.Sprintf("创建账号 %s，工作空间 %d，回填待处理邀请 %d 条", email, orgID, bound),
			TargetUUID:         created.PublicID,
			WorkspaceID:        orgID,
			PendingInvitations: bound,
		})
		return corerepo.WriteAudit(ctx, tx, corerepo.AuditRow{
			OrgID: orgID, UserID: actor.ID, Module: "admin", EntityType: "account",
			EntityID: created.PublicID, Method: "POST", Path: "/api/admin/users",
			Action: "account_created", Message: msg,
		})
	})
	return created, orgID, fault
}

func (s *Users) bootstrap(ctx context.Context, tx pgx.Tx, userID int64, email, display string) (int64, error) {
	var locked int64
	if err := tx.QueryRow(ctx, `SELECT id FROM account_users WHERE id = $1 FOR NO KEY UPDATE`, userID).Scan(&locked); err != nil {
		return 0, err
	}
	var orgID int64
	err := tx.QueryRow(ctx, `
SELECT o.id
FROM organization_members m
JOIN organizations o ON o.id = m.org_id
WHERE m.user_id = $1 AND m.role = 'owner' AND o.dissolved_at IS NULL
ORDER BY o.id ASC
LIMIT 1`, userID).Scan(&orgID)
	if errors.Is(err, pgx.ErrNoRows) {
		var key string
		if err := tx.QueryRow(ctx, `SELECT key FROM plans WHERE key = $1 AND active = true LIMIT 1`, "lite").Scan(&key); err != nil {
			return 0, err
		}
		if err := tx.QueryRow(ctx, `
INSERT INTO organizations
       (owner_user_id, name, plan, seat_limit, psd_upload_enabled, uuid,
        created_at, updated_at)
VALUES ($1, $2, 'lite', 1, false, gen_random_uuid(),
        clock_timestamp(), clock_timestamp())
RETURNING id`, userID, domain.WorkspaceName(display, email)).Scan(&orgID); err != nil {
			return 0, err
		}
	} else if err != nil {
		return 0, err
	}
	if err := tx.QueryRow(ctx, `SELECT id FROM organizations WHERE id = $1 FOR UPDATE`, orgID).Scan(&locked); err != nil {
		return 0, err
	}
	var order int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(join_order), 0) + 1 FROM organization_members WHERE org_id = $1`, orgID).Scan(&order); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO organization_members
       (org_id, user_id, role, status, join_order, display_name, created_at, updated_at)
VALUES ($1, $2, 'owner', 'active', $3, $4, clock_timestamp(), clock_timestamp())
ON CONFLICT (org_id, user_id) DO NOTHING`, orgID, userID, order, display); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `UPDATE account_users SET active_org_id = $1, updated_at = clock_timestamp() WHERE id = $2`, orgID, userID); err != nil {
		return 0, err
	}
	return orgID, nil
}

func (s *Users) bindInvites(ctx context.Context, tx pgx.Tx, userID int64, email string) (int64, error) {
	rows, err := tx.Query(ctx, `
UPDATE org_invitations i
   SET invitee_user_id = $1, updated_at = clock_timestamp()
  FROM organizations o
 WHERE o.id = i.org_id
   AND lower(i.email) = $2
   AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.declined_at IS NULL
   AND i.expires_at > clock_timestamp()
RETURNING i.id, i.role, (EXTRACT(EPOCH FROM i.expires_at) * 1000)::bigint,
          COALESCE(i.invited_by_email, ''), o.name, lower(o.uuid::text)`, userID, email)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var n int64
	type inv struct {
		id                   int64
		role, by, name, uuid string
		expires              int64
	}
	var found []inv
	for rows.Next() {
		var row inv
		if err := rows.Scan(&row.id, &row.role, &row.expires, &row.by, &row.name, &row.uuid); err != nil {
			return 0, err
		}
		found = append(found, row)
		n++
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	rows.Close()
	for _, row := range found {
		payload := corerepo.JSONText(struct {
			TeamName       string `json:"teamName"`
			TeamUUID       string `json:"teamUuid"`
			Role           string `json:"role"`
			InvitedByEmail string `json:"invitedByEmail"`
			ExpiresAtMs    int64  `json:"expiresAtMs"`
		}{row.name, row.uuid, row.role, row.by, row.expires})
		if _, err := tx.Exec(ctx, `
INSERT INTO notifications
       (uuid, user_id, kind, payload, invitation_id, created_at)
VALUES (gen_random_uuid(), $1, 'team_invitation', $2::jsonb, $3, clock_timestamp())
ON CONFLICT (user_id, invitation_id) WHERE invitation_id IS NOT NULL
DO UPDATE SET payload = EXCLUDED.payload,
              created_at = EXCLUDED.created_at,
              read_at = NULL,
              dismissed_at = NULL`, userID, payload, row.id); err != nil {
			return 0, err
		}
	}
	return n, nil
}

func (s *Users) ownedCount(ctx context.Context, tx pgx.Tx, userID int64) (int64, error) {
	var n int64
	err := tx.QueryRow(ctx, `
SELECT COUNT(*)::bigint
FROM organization_members m
JOIN organizations o ON o.id = m.org_id
WHERE m.user_id = $1 AND m.role = 'owner' AND o.dissolved_at IS NULL`, userID).Scan(&n)
	return n, err
}

// SetStatus enables or disables an account inside the admin writer gate.
func (s *Users) SetStatus(ctx context.Context, actor corecontract.Actor, publicID string, enabled bool, path string) (userscontract.Account, *contract.Fault) {
	var out userscontract.Account
	fault := s.withGate(ctx, "admin", "管理域写入未启用", func(ctx context.Context, tx pgx.Tx) error {
		current, err := s.LoadByPublicID(ctx, tx, publicID)
		if err != nil {
			return err
		}
		if userscontract.RankFromStored(current.Role) == userscontract.RankSuper {
			last, err := s.lastSuper(ctx, tx)
			if err != nil {
				return err
			}
			kind := "edit"
			if !enabled {
				kind = "disable"
			}
			if msg, ok := userscontract.Authorize(actor.Role, userscontract.Change{Kind: kind}, current.Role, last); !ok {
				return contract.Forbidden(msg)
			}
		} else if msg, ok := userscontract.Authorize(actor.Role, userscontract.Change{Kind: "edit"}, current.Role, false); !ok {
			return contract.Forbidden(msg)
		}
		sql := `UPDATE account_users SET disabled_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`
		action := "account_disabled"
		summary := "禁用 账号 " + current.Email
		if enabled {
			sql = `UPDATE account_users SET disabled_at = NULL, updated_at = clock_timestamp() WHERE id = $1`
			action = "account_enabled"
			summary = "启用 账号 " + current.Email
		}
		if _, err := tx.Exec(ctx, sql, current.ID); err != nil {
			return err
		}
		out, err = s.LoadByID(ctx, tx, current.ID)
		if err != nil {
			return err
		}
		use := actor.OrgID
		if current.OrgID != nil {
			use = *current.OrgID
		}
		msg := corerepo.JSONText(struct {
			Summary string `json:"summary"`
			Enabled bool   `json:"enabled"`
		}{summary, enabled})
		return corerepo.WriteAudit(ctx, tx, corerepo.AuditRow{
			OrgID: corerepo.OrgFloor(use), UserID: actor.ID, Module: "admin", EntityType: "account",
			EntityID: current.PublicID, Method: "POST", Path: path, Action: action, Message: msg,
		})
	})
	return out, fault
}

// SetRole assigns a platform role inside the admin writer gate.
func (s *Users) SetRole(ctx context.Context, actor corecontract.Actor, publicID, role, path string) (userscontract.Account, *contract.Fault) {
	var out userscontract.Account
	fault := s.withGate(ctx, "admin", "管理域写入未启用", func(ctx context.Context, tx pgx.Tx) error {
		current, err := s.LoadByPublicID(ctx, tx, publicID)
		if err != nil {
			return err
		}
		last := false
		if userscontract.RankFromStored(current.Role) == userscontract.RankSuper {
			last, err = s.lastSuper(ctx, tx)
			if err != nil {
				return err
			}
		}
		if msg, ok := userscontract.Authorize(actor.Role, userscontract.Change{Kind: "assign", Role: role}, current.Role, last); !ok {
			return contract.Forbidden(msg)
		}
		if _, err := tx.Exec(ctx, `UPDATE account_users SET role = $1, updated_at = clock_timestamp() WHERE id = $2`, role, current.ID); err != nil {
			return err
		}
		out, err = s.LoadByID(ctx, tx, current.ID)
		if err != nil {
			return err
		}
		use := actor.OrgID
		if out.OrgID != nil {
			use = *out.OrgID
		}
		msg := corerepo.JSONText(struct {
			Summary string `json:"summary"`
			Role    string `json:"role"`
		}{fmt.Sprintf("将 %s 设为 %s", current.Email, role), role})
		return corerepo.WriteAudit(ctx, tx, corerepo.AuditRow{
			OrgID: corerepo.OrgFloor(use), UserID: actor.ID, Module: "admin", EntityType: "account",
			EntityID: current.PublicID, Method: "POST", Path: path, Action: "account_role_assigned", Message: msg,
		})
	})
	return out, fault
}

// SetPassword replaces the hash and deletes the target's sessions.
func (s *Users) SetPassword(ctx context.Context, actor corecontract.Actor, publicID, hash, path string, self bool) (int64, *contract.Fault) {
	var revoked int64
	fault := s.withGate(ctx, "admin", "管理域写入未启用", func(ctx context.Context, tx pgx.Tx) error {
		current, err := s.LoadByPublicID(ctx, tx, publicID)
		if err != nil {
			return err
		}
		if !self {
			if msg, ok := userscontract.Authorize(actor.Role, userscontract.Change{Kind: "edit"}, current.Role, false); !ok {
				return contract.Forbidden(msg)
			}
		}
		var locked int64
		if err := tx.QueryRow(ctx, `SELECT id FROM account_users WHERE id = $1 FOR NO KEY UPDATE`, current.ID).Scan(&locked); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE account_users SET password_hash = $1, updated_at = clock_timestamp() WHERE id = $2`, hash, current.ID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return errors.New("account_password: missing account")
		}
		tag, err = tx.Exec(ctx, `DELETE FROM account_sessions WHERE user_id = $1`, current.ID)
		if err != nil {
			return err
		}
		revoked = tag.RowsAffected()
		use := actor.OrgID
		if current.OrgID != nil {
			use = *current.OrgID
		}
		msg := corerepo.JSONText(struct {
			Summary         string `json:"summary"`
			SessionsRevoked int64  `json:"sessions_revoked"`
		}{"重置密码 " + current.Email, revoked})
		return corerepo.WriteAudit(ctx, tx, corerepo.AuditRow{
			OrgID: corerepo.OrgFloor(use), UserID: actor.ID, Module: "admin", EntityType: "account",
			EntityID: current.PublicID, Method: "POST", Path: path, Action: "account_password_reset", Message: msg,
		})
	})
	return revoked, fault
}
