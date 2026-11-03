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
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func (s *Users) listMembers(ctx context.Context, tx pgx.Tx, orgID int64) ([]userscontract.MemberRow, error) {
	rows, err := tx.Query(ctx, `
SELECT id, user_id, role, join_order, manual_disabled, quota_suspended
FROM organization_members
WHERE org_id = $1 AND (status='active' OR NOT EXISTS(SELECT 1 FROM subscriptions WHERE org_id=$1))
ORDER BY (role='owner') DESC, join_order ASC, id ASC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []userscontract.MemberRow
	for rows.Next() {
		var m userscontract.MemberRow
		if err := rows.Scan(&m.ID, &m.UserID, &m.Role, &m.JoinOrder, &m.ManualDisabled, &m.QuotaSuspended); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Users) applyMemberFlags(ctx context.Context, tx pgx.Tx, plan userscontract.MemberPlan) error {
	var suspend []int64
	for _, change := range plan.Suspend {
		suspend = append(suspend, change.MembershipID)
	}
	if len(suspend) > 0 {
		if _, err := tx.Exec(ctx, `
UPDATE organization_members
   SET quota_suspended = true, updated_at = clock_timestamp()
 WHERE id = ANY($1::bigint[]) AND role <> 'owner'`, suspend); err != nil {
			return err
		}
	}
	var restore []int64
	for _, change := range plan.Restore {
		restore = append(restore, change.MembershipID)
	}
	if len(restore) > 0 {
		if _, err := tx.Exec(ctx, `
UPDATE organization_members
   SET quota_suspended = false, updated_at = clock_timestamp()
 WHERE id = ANY($1::bigint[])`, restore); err != nil {
			return err
		}
	}
	return nil
}

// EnsureOwner returns the account's first live owner org, bootstrapping one
// when the owned-workspace count is under the limit.
func (s *Users) EnsureOwner(ctx context.Context, tx pgx.Tx, account userscontract.Account, email, name string) (int64, error) {
	if account.OrgID != nil {
		return *account.OrgID, nil
	}
	n, err := s.ownedCount(ctx, tx, account.ID)
	if err != nil {
		return 0, err
	}
	if n >= domain.OwnedLimit() {
		return 0, contract.Forbidden("该账号自建工作空间已达上限")
	}
	return s.bootstrap(ctx, tx, account.ID, email, name)
}

// SetSeats ensures an owner org, writes the member override (nil clears it so
// the workspace follows the global cap), and reconciles members inside one
// admin gate. Store limits are never touched.
func (s *Users) SetSeats(ctx context.Context, actor corecontract.Actor, publicID, path string, seats *int64) (userscontract.Account, *contract.Fault) {
	var out userscontract.Account
	fault := s.withGate(ctx, "admin", "管理域写入未启用", func(ctx context.Context, tx pgx.Tx) error {
		account, err := s.LoadByPublicID(ctx, tx, publicID)
		if err != nil {
			return err
		}
		if account.ID != actor.ID {
			if msg, ok := userscontract.Authorize(actor.Role, userscontract.Change{Kind: "edit"}, account.Role, false); !ok {
				return contract.Forbidden(msg)
			}
		}
		orgID, err := s.EnsureOwner(ctx, tx, account, account.Email, account.Name)
		if err != nil {
			return err
		}
		if err := tenantx.EnterApp(ctx, tx, orgID); err != nil {
			return err
		}
		var revision int64
		var was *int64
		err = tx.QueryRow(ctx, `
SELECT quota_revision, member_seat_limit_override
FROM organizations
WHERE id = $1 AND dissolved_at IS NULL
FOR UPDATE`, orgID).Scan(&revision, &was)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.NotFound("组织不存在")
		}
		if err != nil {
			return err
		}
		var from int64
		if err := tx.QueryRow(ctx, `SELECT members FROM public.subscription_capacity($1, clock_timestamp())`, orgID).Scan(&from); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
UPDATE organizations
   SET member_seat_limit_override = $2,
       quota_revision = quota_revision + 1,
       updated_at = clock_timestamp()
 WHERE id = $1`, orgID, seats); err != nil {
			return err
		}
		var limit int64
		if err := tx.QueryRow(ctx, `SELECT members FROM public.subscription_capacity($1, clock_timestamp())`, orgID).Scan(&limit); err != nil {
			return err
		}
		rows, err := s.listMembers(ctx, tx, orgID)
		if err != nil {
			return err
		}
		plan := userscontract.PlanMembers(limit, rows)
		if err := s.applyMemberFlags(ctx, tx, plan); err != nil {
			return err
		}
		var userIDs []int64
		for _, change := range plan.Suspend {
			userIDs = append(userIDs, change.UserID)
		}
		var sessions int64
		if len(userIDs) > 0 {
			tag, err := tx.Exec(ctx, `DELETE FROM account_sessions WHERE user_id = ANY($1::bigint[])`, userIDs)
			if err != nil {
				return err
			}
			sessions = tag.RowsAffected()
		}
		out, err = s.LoadByID(ctx, tx, account.ID)
		if err != nil {
			return err
		}
		body := corerepo.JSONText(map[string]any{
			"summary":                    fmt.Sprintf("成员名额 %d → %d，revision %d → %d", from, limit, revision, revision+1),
			"actor":                      actor.Email,
			"member_limit":               map[string]any{"from": from, "to": limit},
			"member_seat_limit_override": map[string]any{"from": nilInt(was), "to": nilInt(seats)},
			"revision":                   map[string]any{"from": revision, "to": revision + 1},
			"suspend":                    plan.Suspend,
			"restore":                    plan.Restore,
			"sessions_deleted":           sessions,
		})
		return corerepo.WriteAudit(ctx, tx, corerepo.AuditRow{
			OrgID: orgID, UserID: actor.ID, Module: "admin", EntityType: "account",
			EntityID: account.PublicID, Method: "POST", Path: path, Action: "account_member_seats_applied", Message: body,
		})
	})
	return out, fault
}

func nilInt(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}
