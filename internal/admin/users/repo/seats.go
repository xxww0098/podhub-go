package usersrepo

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	contract "github.com/xxww0098/podhub-go/internal/admin/core/contract/apifault"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	userscontract "github.com/xxww0098/podhub-go/internal/admin/users/contract"
	"github.com/xxww0098/podhub-go/internal/admin/users/domain"
)

func (s *Users) loadSeat(ctx context.Context, tx pgx.Tx, orgID, ownerID int64, forUpdate, ownerFilter bool) (userscontract.SeatLoad, error) {
	sql := `
SELECT o.id, o.plan, o.seat_limit, o.quota_revision,
       o.store_limit_override, o.member_seat_limit_override
FROM organizations o
WHERE o.id = $1 AND o.dissolved_at IS NULL`
	args := []any{orgID}
	if ownerFilter {
		sql = `
SELECT o.id, o.plan, o.seat_limit, o.quota_revision,
       o.store_limit_override, o.member_seat_limit_override
FROM organizations o
WHERE o.id = $1 AND o.owner_user_id = $2 AND o.dissolved_at IS NULL`
		args = []any{orgID, ownerID}
	}
	if forUpdate {
		sql += ` FOR UPDATE OF o`
	}
	var st userscontract.SeatState
	err := tx.QueryRow(ctx, sql, args...).Scan(&st.OrgID, &st.Plan, &st.SeatLimit, &st.Revision, &st.StoreOverride, &st.MemberOverride)
	if errors.Is(err, pgx.ErrNoRows) {
		return userscontract.SeatLoad{}, contract.NotFound("组织不存在")
	}
	if err != nil {
		return userscontract.SeatLoad{}, err
	}
	lotRows, err := tx.Query(ctx, `
WITH clock AS (SELECT clock_timestamp() AS now)
SELECT tier, COALESCE(SUM(seats), 0)::bigint
FROM member_seat_lots
CROSS JOIN clock
WHERE org_id = $1 AND starts_at <= clock.now AND expires_at > clock.now
GROUP BY tier`, orgID)
	if err != nil {
		return userscontract.SeatLoad{}, err
	}
	for lotRows.Next() {
		var lot userscontract.Lot
		if err := lotRows.Scan(&lot.Tier, &lot.Seats); err != nil {
			lotRows.Close()
			return userscontract.SeatLoad{}, err
		}
		st.Lots = append(st.Lots, lot)
	}
	if err := lotRows.Err(); err != nil {
		lotRows.Close()
		return userscontract.SeatLoad{}, err
	}
	lotRows.Close()
	var expires *time.Time
	if err := tx.QueryRow(ctx, `
WITH clock AS (SELECT clock_timestamp() AS now)
SELECT MAX(expires_at)
FROM member_seat_lots
CROSS JOIN clock
WHERE org_id = $1 AND expires_at > clock.now`, orgID).Scan(&expires); err != nil {
		return userscontract.SeatLoad{}, err
	}
	st.Expires = expires
	members, err := s.listMembers(ctx, tx, orgID)
	if err != nil {
		return userscontract.SeatLoad{}, err
	}
	stores, err := s.listStores(ctx, tx, orgID, false)
	if err != nil {
		return userscontract.SeatLoad{}, err
	}
	return userscontract.SeatLoad{State: st, Members: members, Stores: stores}, nil
}

func (s *Users) listMembers(ctx context.Context, tx pgx.Tx, orgID int64) ([]userscontract.MemberRow, error) {
	rows, err := tx.Query(ctx, `
SELECT id, user_id, role, join_order, manual_disabled, quota_suspended
FROM organization_members
WHERE org_id = $1
ORDER BY join_order ASC, id ASC`, orgID)
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

func (s *Users) listStores(ctx context.Context, tx pgx.Tx, orgID int64, lock bool) ([]userscontract.StoreRow, error) {
	sql := `
SELECT s.id, lower(s.uuid::text), s.create_order,
       s.manual_disabled, s.quota_suspended,
       COALESCE(c.last_leased_at_ms, 0)
FROM organization_stores s
LEFT JOIN store_seller_credentials c
  ON c.store_id = s.id AND c.credential_revision = s.credential_revision
WHERE s.org_id = $1 AND s.deleted_at_ms IS NULL
ORDER BY coalesce(c.last_leased_at_ms, 0) DESC, s.create_order ASC, s.id ASC`
	if lock {
		sql += ` FOR UPDATE OF s`
	}
	rows, err := tx.Query(ctx, sql, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []userscontract.StoreRow
	for rows.Next() {
		var row userscontract.StoreRow
		if err := rows.Scan(&row.ID, &row.UUID, &row.CreateOrder, &row.ManualDisabled, &row.QuotaSuspended, &row.LastUsed); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// PreviewSeats loads without FOR UPDATE. It does not audit and does not bootstrap.
func (s *Users) PreviewSeats(ctx context.Context, publicID string, workspaceID *int64) (userscontract.Account, userscontract.SeatLoad, *contract.Fault) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return userscontract.Account{}, userscontract.SeatLoad{}, corerepo.DBFault(err)
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	account, err := s.LoadByPublicID(ctx, tx, publicID)
	if err != nil {
		return userscontract.Account{}, userscontract.SeatLoad{}, corerepo.PlainFault(err)
	}
	orgID, ownerFilter, fault := seatOrg(account, workspaceID)
	if fault != nil {
		return account, userscontract.SeatLoad{}, fault
	}
	load, err := s.loadSeat(ctx, tx, orgID, account.ID, false, ownerFilter)
	if err != nil {
		return account, userscontract.SeatLoad{}, corerepo.PlainFault(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return userscontract.Account{}, userscontract.SeatLoad{}, corerepo.DBFault(err)
	}
	return account, load, nil
}

func seatOrg(account userscontract.Account, workspaceID *int64) (int64, bool, *contract.Fault) {
	if workspaceID != nil {
		return *workspaceID, true, nil
	}
	if account.OrgID == nil {
		return 0, false, contract.NotFound("组织不存在")
	}
	return *account.OrgID, false, nil
}

// ApplySeats CAS-updates quota and reconciles members and stores inside the admin gate.
func (s *Users) ApplySeats(ctx context.Context, actor corecontract.Actor, publicID, path string, workspaceID *int64, intent userscontract.SeatIntent, expectedRevision, expectedStores int64) (userscontract.MemberPlan, userscontract.StorePlan, userscontract.SeatTarget, int64, *contract.Fault) {
	var members userscontract.MemberPlan
	var stores userscontract.StorePlan
	var target userscontract.SeatTarget
	var next int64
	fault := s.withGate(ctx, "admin", "管理域写入未启用", func(ctx context.Context, tx pgx.Tx) error {
		account, err := s.LoadByPublicID(ctx, tx, publicID)
		if err != nil {
			return err
		}
		orgID, ownerFilter, fault := seatOrg(account, workspaceID)
		if fault != nil {
			return fault
		}
		load, err := s.loadSeat(ctx, tx, orgID, account.ID, true, ownerFilter)
		if err != nil {
			return err
		}
		if expectedRevision != load.State.Revision {
			return contract.Conflict("配额状态已变化，请重新预览")
		}
		var msg string
		target, msg = userscontract.ResolveSeats(load.State, intent)
		if msg != "" {
			return contract.Validation(msg)
		}
		if target.StoreLimit != expectedStores {
			return contract.Conflict("店铺名额已变化，请重新预览")
		}
		tag, err := tx.Exec(ctx, `
UPDATE organizations
   SET member_seat_limit_override = $1, store_limit_override = $2,
       plan = $3, seat_limit = $4, plan_expires_at = $5,
       quota_revision = quota_revision + 1,
       updated_at = clock_timestamp()
 WHERE id = $6 AND quota_revision = $7`,
			target.MemberOverride, target.StoreOverride, target.Plan, target.SeatLimit, target.Expires,
			load.State.OrgID, load.State.Revision)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return contract.Conflict("配额状态已变化，请重新预览")
		}
		next = load.State.Revision + 1
		stores, err = s.reconcileStores(ctx, tx, load.State.OrgID, target.StoreLimit, true)
		if err != nil {
			return err
		}
		fresh, err := s.listMembers(ctx, tx, load.State.OrgID)
		if err != nil {
			return err
		}
		members = userscontract.PlanMembers(target.SeatLimit, fresh)
		if err := s.applyMemberFlags(ctx, tx, members); err != nil {
			return err
		}
		var userIDs []int64
		for _, change := range members.Suspend {
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
		if _, err := s.reconcileStoresAgain(ctx, tx, load.State.OrgID, target.Plan); err != nil {
			return err
		}
		storeFrom := load.State.SeatLimit
		var storeWas any
		if load.State.StoreOverride != nil {
			storeWas = *load.State.StoreOverride
		}
		var storeNow any
		if target.StoreOverride != nil {
			storeNow = *target.StoreOverride
		}
		var memberWas any
		if load.State.MemberOverride != nil {
			memberWas = *load.State.MemberOverride
		}
		var memberNow any
		if target.MemberOverride != nil {
			memberNow = *target.MemberOverride
		}
		planDefault := userscontract.StoreQuotaFor(userscontract.TierKey(load.State.Plan), load.State.SeatLimit)
		shownFrom := planDefault
		if load.State.StoreOverride != nil {
			shownFrom = *load.State.StoreOverride
		}
		summary := fmt.Sprintf("成员名额 %d → %d，店铺名额 %d → %d，权益 %s → %s，revision %d → %d",
			storeFrom, target.SeatLimit, shownFrom, target.StoreLimit, load.State.Plan, target.Plan, load.State.Revision, next)
		msg = corerepo.JSONText(map[string]any{
			"summary": summary, "actor": actor.Email,
			"plan":                       map[string]any{"from": load.State.Plan, "to": target.Plan},
			"member_seats":               map[string]any{"from": storeFrom, "to": target.SeatLimit},
			"member_seat_limit_override": map[string]any{"from": memberWas, "to": memberNow},
			"store_limit_override":       map[string]any{"from": storeWas, "to": storeNow},
			"revision":                   map[string]any{"from": load.State.Revision, "to": next},
			"follow_plan_member_seats":   target.FollowMembers,
			"follow_plan_store_limit":    target.FollowStores,
			"suspend":                    members.Suspend,
			"restore":                    members.Restore,
			"sessions_deleted":           sessions,
			"store_suspend":              stores.Suspend,
			"store_restore":              stores.Restore,
		})
		return corerepo.WriteAudit(ctx, tx, corerepo.AuditRow{
			OrgID: load.State.OrgID, UserID: actor.ID, Module: "admin", EntityType: "account",
			EntityID: account.PublicID, Method: "POST", Path: path, Action: "account_member_seats_applied", Message: msg,
		})
	})
	return members, stores, target, next, fault
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

func (s *Users) reconcileStores(ctx context.Context, tx pgx.Tx, orgID, limit int64, lock bool) (userscontract.StorePlan, error) {
	if limit < 1 {
		limit = 1
	}
	rows, err := s.listStores(ctx, tx, orgID, lock)
	if err != nil {
		return userscontract.StorePlan{}, err
	}
	plan := userscontract.PlanStores(limit, rows)
	if err := s.applyStoreFlags(ctx, tx, rows, plan); err != nil {
		return userscontract.StorePlan{}, err
	}
	return plan, nil
}

func (s *Users) applyStoreFlags(ctx context.Context, tx pgx.Tx, rows []userscontract.StoreRow, plan userscontract.StorePlan) error {
	byUUID := map[string]int64{}
	for _, row := range rows {
		byUUID[row.UUID] = row.ID
	}
	var suspend, restore []int64
	for _, change := range plan.Suspend {
		if id, ok := byUUID[change.UUID]; ok {
			suspend = append(suspend, id)
		}
	}
	for _, change := range plan.Restore {
		if id, ok := byUUID[change.UUID]; ok {
			restore = append(restore, id)
		}
	}
	if len(suspend) > 0 {
		if _, err := tx.Exec(ctx, `
UPDATE organization_stores
   SET quota_suspended = true, revision = revision + 1, updated_at = clock_timestamp()
 WHERE id = ANY($1::bigint[]) AND deleted_at_ms IS NULL AND quota_suspended IS DISTINCT FROM true`, suspend); err != nil {
			return err
		}
	}
	if len(restore) > 0 {
		if _, err := tx.Exec(ctx, `
UPDATE organization_stores
   SET quota_suspended = false, revision = revision + 1, updated_at = clock_timestamp()
 WHERE id = ANY($1::bigint[]) AND deleted_at_ms IS NULL AND quota_suspended IS DISTINCT FROM false`, restore); err != nil {
			return err
		}
	}
	return nil
}

func (s *Users) reconcileStoresAgain(ctx context.Context, tx pgx.Tx, orgID int64, tier string) (userscontract.StorePlan, error) {
	var seat int64
	var override *int64
	err := tx.QueryRow(ctx, `SELECT seat_limit, store_limit_override FROM organizations WHERE id = $1`, orgID).Scan(&seat, &override)
	if errors.Is(err, pgx.ErrNoRows) {
		return userscontract.StorePlan{}, errors.New("Workspace 不存在")
	}
	if err != nil {
		return userscontract.StorePlan{}, err
	}
	purchased := seat
	if purchased < 1 {
		purchased = 1
	}
	effectiveMembers := purchased
	if seat < 1 {
		effectiveMembers = 1
	}
	limit := userscontract.StoreQuotaFor(tier, effectiveMembers)
	if override != nil && *override >= 1 {
		limit = *override
	}
	return s.reconcileStores(ctx, tx, orgID, limit, true)
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

// SetSeats ensures an owner org, previews, and applies inside one admin gate.
func (s *Users) SetSeats(ctx context.Context, actor corecontract.Actor, publicID, path string, seats int64) (userscontract.Account, *contract.Fault) {
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
		load, err := s.loadSeat(ctx, tx, orgID, account.ID, true, false)
		if err != nil {
			return err
		}
		intent := userscontract.SeatIntent{MemberOverride: &seats, FollowMembers: false, FollowStores: false}
		target, msg := userscontract.ResolveSeats(load.State, intent)
		if msg != "" {
			return contract.Validation(msg)
		}
		tag, err := tx.Exec(ctx, `
UPDATE organizations
   SET member_seat_limit_override = $1, store_limit_override = $2,
       plan = $3, seat_limit = $4, plan_expires_at = $5,
       quota_revision = quota_revision + 1,
       updated_at = clock_timestamp()
 WHERE id = $6 AND quota_revision = $7`,
			target.MemberOverride, target.StoreOverride, target.Plan, target.SeatLimit, target.Expires,
			load.State.OrgID, load.State.Revision)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return contract.Conflict("配额状态已变化，请重新预览")
		}
		if _, err := s.reconcileStores(ctx, tx, load.State.OrgID, target.StoreLimit, true); err != nil {
			return err
		}
		fresh, err := s.listMembers(ctx, tx, load.State.OrgID)
		if err != nil {
			return err
		}
		plan := userscontract.PlanMembers(target.SeatLimit, fresh)
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
		if _, err := s.reconcileStoresAgain(ctx, tx, load.State.OrgID, target.Plan); err != nil {
			return err
		}
		out, err = s.LoadByID(ctx, tx, account.ID)
		if err != nil {
			return err
		}
		next := load.State.Revision + 1
		shownFrom := userscontract.StoreQuotaFor(userscontract.TierKey(load.State.Plan), load.State.SeatLimit)
		if load.State.StoreOverride != nil {
			shownFrom = *load.State.StoreOverride
		}
		summary := fmt.Sprintf("成员名额 %d → %d，店铺名额 %d → %d，权益 %s → %s，revision %d → %d",
			load.State.SeatLimit, target.SeatLimit, shownFrom, target.StoreLimit, load.State.Plan, target.Plan, load.State.Revision, next)
		body := corerepo.JSONText(map[string]any{
			"summary": summary, "actor": actor.Email,
			"plan":                       map[string]any{"from": load.State.Plan, "to": target.Plan},
			"member_seats":               map[string]any{"from": load.State.SeatLimit, "to": target.SeatLimit},
			"member_seat_limit_override": map[string]any{"from": nilInt(load.State.MemberOverride), "to": nilInt(target.MemberOverride)},
			"store_limit_override":       map[string]any{"from": nilInt(load.State.StoreOverride), "to": nilInt(target.StoreOverride)},
			"revision":                   map[string]any{"from": load.State.Revision, "to": next},
			"follow_plan_member_seats":   false,
			"follow_plan_store_limit":    target.FollowStores,
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
