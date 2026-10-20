package adminrepo

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

func scanSupportGrant(row pgx.Row) (domain.Grant, error) {
	var g domain.Grant
	err := row.Scan(&g.ID, &g.OrgID, &g.StaffUserID, &g.StaffEmail, &g.Reason, &g.ExpiresAt, &g.RevokedAt, &g.CreatedBy, &g.CreatedAt, &g.LastAccess)
	return g, err
}

const supportGrantSelect = `
SELECT g.id, g.org_id, g.staff_user_id, COALESCE(u.email, '') AS staff_email,
       g.reason,
       (EXTRACT(EPOCH FROM g.expires_at) * 1000)::bigint AS expires_at_ms,
       COALESCE((EXTRACT(EPOCH FROM g.revoked_at) * 1000)::bigint, 0) AS revoked_at_ms,
       g.created_by_user_id,
       (EXTRACT(EPOCH FROM g.created_at) * 1000)::bigint AS created_at_ms,
       COALESCE((
           SELECT MAX(a.created_at_ms) FROM audit_logs a
           WHERE a.support_grant_id = g.id AND a.action = 'support_write'
       ), 0) AS last_access_at_ms
FROM support_grants g
LEFT JOIN account_users u ON u.id = g.staff_user_id`

// ListGrants reads grants and then audits. orgFilter nil lists every org.
func (s *Store) ListGrants(ctx context.Context, actor domain.Actor, orgFilter *int64) ([]domain.Grant, *contract.Fault) {
	rows, err := s.pool.Query(ctx, supportGrantSelect+`
WHERE ($1::bigint IS NULL OR g.org_id = $1)
ORDER BY g.id DESC`, orgFilter)
	if err != nil {
		return nil, dbFault(err)
	}
	defer rows.Close()
	var out []domain.Grant
	for rows.Next() {
		g, err := scanSupportGrant(rows)
		if err != nil {
			return nil, dbFault(err)
		}
		out = append(out, g)
	}
	if err := rows.Err(); err != nil {
		return nil, dbFault(err)
	}
	if out == nil {
		out = []domain.Grant{}
	}
	org := actor.OrgID
	if orgFilter != nil {
		org = *orgFilter
	}
	var filter any
	if orgFilter != nil {
		filter = *orgFilter
	}
	msg := jsonText(struct {
		Summary string `json:"summary"`
		Count   int    `json:"count"`
		OrgID   any    `json:"org_id"`
	}{fmt.Sprintf("列出 support grants %d 条", len(out)), len(out), filter})
	if err := s.auditAfter(ctx, auditRow{
		OrgID: orgFloor(org), UserID: actor.ID, Module: "support", EntityType: "support_grant",
		EntityID: "*", Method: "GET", Path: "/api/admin/support-grants", Action: "support_grants_listed", Message: msg,
	}); err != nil {
		return nil, dbFault(err)
	}
	return out, nil
}

// IssueGrant inserts one live grant inside the admin writer gate.
func (s *Store) IssueGrant(ctx context.Context, actor domain.Actor, req domain.GrantRequest, expires time.Time) (domain.Grant, *contract.Fault) {
	var out domain.Grant
	fault := s.withGate(ctx, "admin", "管理域写入未启用", func(ctx context.Context, tx pgx.Tx) error {
		var email, role string
		err := tx.QueryRow(ctx, `SELECT email, role FROM account_users WHERE id = $1 LIMIT 1`, req.StaffUserID).Scan(&email, &role)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.Validation("平台人员不存在")
		}
		if err != nil {
			return err
		}
		if !domain.Staff(role) {
			return contract.Validation("support grant 只能签给平台人员；租户内权限请改成员角色")
		}
		var orgID int64
		err = tx.QueryRow(ctx, `SELECT id FROM organizations WHERE id = $1 LIMIT 1`, req.OrgID).Scan(&orgID)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.Validation("组织不存在")
		}
		if err != nil {
			return err
		}
		row := tx.QueryRow(ctx, `
INSERT INTO support_grants
       (org_id, staff_user_id, reason, expires_at, created_by_user_id,
        revoked_at, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, NULL, clock_timestamp(), clock_timestamp())
RETURNING id, org_id, staff_user_id, reason,
          (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint,
          0::bigint,
          created_by_user_id,
          (EXTRACT(EPOCH FROM created_at) * 1000)::bigint`,
			req.OrgID, req.StaffUserID, req.Reason, expires, actor.ID)
		var g domain.Grant
		if err := row.Scan(&g.ID, &g.OrgID, &g.StaffUserID, &g.Reason, &g.ExpiresAt, &g.RevokedAt, &g.CreatedBy, &g.CreatedAt); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return contract.Conflict("该平台人员对组织已有生效授权，续期请先撤销")
			}
			if errors.Is(err, pgx.ErrNoRows) {
				return contract.Internal("签发失败")
			}
			return err
		}
		g.StaffEmail = email
		out = g
		msg := jsonText(struct {
			Summary     string `json:"summary"`
			StaffEmail  string `json:"staff_email"`
			Reason      string `json:"reason"`
			ExpiresAtMs int64  `json:"expires_at_ms"`
		}{
			fmt.Sprintf("签发 support grant #%d：平台人员 %s 可写组织 %d，有效 %d 分钟", g.ID, email, req.OrgID, req.TTLMinutes),
			email, req.Reason, g.ExpiresAt,
		})
		return writeAudit(ctx, tx, auditRow{
			OrgID: req.OrgID, UserID: actor.ID, Module: "support", EntityType: "support_grant",
			EntityID: fmt.Sprint(g.ID), Method: "POST", Path: "/api/admin/support-grants",
			Action: "support_grant_issued", Message: msg,
		})
	})
	return out, fault
}

// RevokeGrant revokes or replays. There is no row lock.
func (s *Store) RevokeGrant(ctx context.Context, actor domain.Actor, id int64, path string) (bool, *contract.Fault) {
	var revoked bool
	fault := s.withGate(ctx, "admin", "管理域写入未启用", func(ctx context.Context, tx pgx.Tx) error {
		var orgID int64
		var already bool
		err := tx.QueryRow(ctx, `SELECT id, org_id, revoked_at IS NOT NULL FROM support_grants WHERE id = $1 LIMIT 1`, id).Scan(&id, &orgID, &already)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.NotFound("授权不存在")
		}
		if err != nil {
			return err
		}
		action := "support_grant_revoked"
		summary := fmt.Sprintf("撤销 support grant #%d（组织 %d）", id, orgID)
		replay := false
		if already {
			action = "support_grant_revoke_replayed"
			summary = fmt.Sprintf("support grant #%d 已经撤销", id)
			replay = true
			revoked = false
		} else {
			if _, err := tx.Exec(ctx, `
UPDATE support_grants
   SET revoked_at = clock_timestamp(), updated_at = clock_timestamp()
 WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL`, id, orgID); err != nil {
				return err
			}
			revoked = true
		}
		msg := jsonText(struct {
			Summary   string `json:"summary"`
			RevokedBy string `json:"revoked_by,omitempty"`
			Replay    bool   `json:"replay,omitempty"`
		}{summary, actor.Email, replay})
		if already {
			msg = jsonText(struct {
				Summary string `json:"summary"`
				Replay  bool   `json:"replay"`
			}{summary, true})
		}
		return writeAudit(ctx, tx, auditRow{
			OrgID: orgID, UserID: actor.ID, Module: "support", EntityType: "support_grant",
			EntityID: fmt.Sprint(id), Method: "POST", Path: path, Action: action, Message: msg,
		})
	})
	return revoked, fault
}
