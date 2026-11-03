package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

var (
	errWorkspaceNotFound       = errors.New("工作空间不存在或已解散")
	errWorkspaceForbidden      = errors.New("无权执行该工作空间操作")
	errWorkspaceDissolveName   = errors.New("请输入当前工作空间名称以确认解散")
	errWorkspaceBusy           = errors.New("有进行中的 AI 请求尚未结算，请稍后再解散")
	errWorkspacePendingPayment = errors.New("有线上支付订单尚未结清，请确认付款或渠道关单后再解散")
	errWorkspaceOwnerLeave     = errors.New("所有者不能退出工作空间；请先解散工作空间")
	errWorkspaceNoSeat         = errors.New("当前账号没有可退出的工作空间")
	errWorkspaceSeatAmbiguous  = errors.New("有多个不可用的工作空间，请指定要退出的工作空间")
	errWorkspaceMemberMissing  = errors.New("成员不存在或已离开工作空间")
	errWorkspaceRoleInvalid    = errors.New("工作空间角色无效")
)

type workspacesWire struct {
	Data workspacesDataWire `json:"data"`
}

type workspacesDataWire struct {
	Workspaces      []workspaceWire `json:"workspaces"`
	ActiveWorkspace *workspaceWire  `json:"active_workspace"`
	AccountMode     string          `json:"account_mode"`
	OwnedCount      int64           `json:"owned_count"`
	OwnedLimit      int64           `json:"owned_limit"`
}

type workspaceNameRequest struct {
	Name string `json:"name"`
}

type leaveWorkspaceRequest struct {
	WorkspaceID *int64 `json:"workspace_id"`
}

type workspaceMemberRoleRequest struct {
	Role string `json:"role"`
}

// inOrgTx runs a tenant write as the application role with app.current_org_id
// set. Rename, dissolve and roster edits read and write tenant-scoped tables,
// so app.current_org_id must be set before the first statement of the
// transaction; db.InTx on AppRole alone would leave those rows hidden.
func (s *Service) inOrgTx(ctx context.Context, orgID int64, fn func(pgx.Tx, *sqlc.Queries) (bool, error)) error {
	return db.InTx(ctx, s.pool, db.App(orgID), func(tx pgx.Tx) error {
		audited, err := fn(tx, sqlc.New(tx))
		if err != nil {
			return err
		}
		if !audited {
			return errors.New("audit sink empty")
		}
		return nil
	})
}

// lockWorkspace serialises lifecycle edits against a dissolve. It is the
// same first lock order as the super-admin dissolve: organization row before
// membership rows.
func lockWorkspace(ctx context.Context, tx pgx.Tx, orgID int64) error {
	var id int64
	err := tx.QueryRow(ctx, `SELECT id FROM organizations WHERE id=$1 AND dissolved_at IS NULL FOR NO KEY UPDATE`, orgID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return errWorkspaceNotFound
	}
	return err
}

// nextActiveOrg picks the account's next live workspace after a membership is
// deleted. The lookup must cross the target org boundary (a personal workspace
// usually sits in another org), so it briefly uses the staff arm. Every
// statement is filtered by user_id, and the arm is cleared before returning.
func nextActiveOrg(ctx context.Context, tx pgx.Tx, userID int64) (int64, error) {
	if _, err := tx.Exec(ctx, `SELECT set_config('app.staff_access', '1', true)`); err != nil {
		return 0, err
	}
	var next int64
	err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT o.id FROM organization_members m JOIN organizations o ON o.id=m.org_id JOIN account_profiles p ON p.user_id=m.user_id WHERE m.user_id=$1 AND m.status='active' AND NOT m.manual_disabled AND NOT m.quota_suspended AND o.dissolved_at IS NULL ORDER BY (o.id = p.active_org_id) DESC NULLS LAST, (m.role='owner') DESC, o.id ASC LIMIT 1), 0)`, userID).Scan(&next)
	if _, resetErr := tx.Exec(ctx, `SELECT set_config('app.staff_access', '', true)`); resetErr != nil {
		return 0, resetErr
	}
	return next, err
}

// decodeOptionalWorkspaceJSON accepts an absent body. LeaveWorkspace is called
// without a body when the current workspace is the target, while the strict
// decoder used elsewhere rejects the empty stream.
func decodeOptionalWorkspaceJSON(r *http.Request, dst any) error {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8193))
	if err != nil {
		return err
	}
	if len(raw) == 0 {
		return nil
	}
	if len(raw) > 8192 {
		return errors.New("request body too large")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return errors.New("trailing data")
	}
	return nil
}

func (s *Service) workspacesData(ctx context.Context, acc account) ([]byte, error) {
	var rows []sqlc.ListWorkspacesRow
	var standing sqlc.AccountStandingRow
	err := s.withQueries(ctx, func(q *sqlc.Queries) error {
		var err error
		if rows, err = q.ListWorkspaces(ctx, acc.id); err != nil {
			return err
		}
		standing, err = q.AccountStanding(ctx, acc.id)
		return err
	})
	if err != nil {
		return nil, err
	}
	out := workspacesWire{}
	out.Data.Workspaces = make([]workspaceWire, 0, len(rows))
	for _, row := range rows {
		wire := workspaceFrom(row.ID, row.Uuid, row.Name, row.Plan, row.Role, row.IsOwned, row.MemberCount, row.AvatarRevision)
		out.Data.Workspaces = append(out.Data.Workspaces, wire)
		if row.ID == acc.orgID {
			copy := wire
			out.Data.ActiveWorkspace = &copy
		}
	}
	if out.Data.ActiveWorkspace == nil && len(out.Data.Workspaces) > 0 {
		copy := out.Data.Workspaces[0]
		out.Data.ActiveWorkspace = &copy
	}
	out.Data.AccountMode = projectAccountMode(standing.OwnedCount, standing.MembershipCount)
	out.Data.OwnedCount = standing.OwnedCount
	out.Data.OwnedLimit = maxOwnedWorkspaces
	return json.Marshal(out)
}

func (s *Service) workspacesResult(ctx context.Context, acc account) Result {
	body, err := s.workspacesData(ctx, acc)
	if err != nil {
		return dbResult(err)
	}
	return Result{Status: http.StatusOK, Body: body}
}

func workspaceFailure(err error) Result {
	switch {
	case errors.Is(err, errWorkspaceForbidden), errors.Is(err, errWorkspaceNotFound), errors.Is(err, errWorkspaceOwnerLeave):
		return authResult(http.StatusForbidden, err.Error(), "FORBIDDEN")
	case errors.Is(err, errWorkspaceBusy), errors.Is(err, errWorkspacePendingPayment),
		errors.Is(err, errWorkspaceDissolveName), errors.Is(err, errWorkspaceNoSeat),
		errors.Is(err, errWorkspaceSeatAmbiguous), errors.Is(err, errWorkspaceMemberMissing),
		errors.Is(err, errWorkspaceRoleInvalid):
		return authResult(http.StatusBadRequest, err.Error(), "VALIDATION")
	default:
		return dbResult(err)
	}
}

// ListWorkspaces is GET /api/workspaces. The Workspace screen gets the richer
// session projection from /api/view/account; this endpoint exists for clients
// that only need the standing and the selectable workspaces.
func (s *Service) ListWorkspaces(r *http.Request) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	return s.workspacesResult(r.Context(), acc)
}

// RenameWorkspace is PUT /api/workspaces/name and changes only the current
// workspace. Owner-only, matching the permission the directory reports.
func (s *Service) RenameWorkspace(r *http.Request) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	if acc.orgID <= 0 {
		return authResult(http.StatusForbidden, msgNoWorkspace, "FORBIDDEN")
	}
	var body workspaceNameRequest
	if err := strictJSON(r, &body); err != nil {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	name, err := validateWorkspaceName(body.Name)
	if err != nil {
		return authResult(http.StatusBadRequest, err.Error(), "VALIDATION")
	}
	err = s.inOrgTx(r.Context(), acc.orgID, func(tx pgx.Tx, q *sqlc.Queries) (bool, error) {
		ctx := r.Context()
		var current string
		err := tx.QueryRow(ctx, `SELECT name FROM organizations WHERE id=$1 AND dissolved_at IS NULL FOR UPDATE`, acc.orgID).Scan(&current)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, errWorkspaceNotFound
		}
		if err != nil {
			return false, err
		}
		var storedRole string
		err = tx.QueryRow(ctx, `SELECT role FROM organization_members WHERE org_id=$1 AND user_id=$2 AND status='active' AND NOT manual_disabled AND NOT quota_suspended FOR UPDATE`, acc.orgID, acc.id).Scan(&storedRole)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, errWorkspaceForbidden
		}
		if err != nil {
			return false, err
		}
		role, ok := access.ParseWorkspace(storedRole)
		if !ok || role != access.WorkspaceOwner {
			return false, errWorkspaceForbidden
		}
		if current == name {
			return true, q.InsertAudit(ctx, sqlc.InsertAuditParams{
				OrgID: acc.orgID, UserID: acc.id, Module: "auth", EntityType: "workspace",
				EntityID: itoa(acc.orgID), ApiMethod: "PUT", ApiPath: "/api/workspaces/name",
				Action: "workspace_rename_unchanged", Message: workspaceAuditMessage("工作空间名称未变化", name),
			})
		}
		if _, err := tx.Exec(ctx, `UPDATE organizations SET name=$1, updated_at=clock_timestamp() WHERE id=$2 AND dissolved_at IS NULL`, name, acc.orgID); err != nil {
			return false, err
		}
		return true, q.InsertAudit(ctx, sqlc.InsertAuditParams{
			OrgID: acc.orgID, UserID: acc.id, Module: "auth", EntityType: "workspace",
			EntityID: itoa(acc.orgID), ApiMethod: "PUT", ApiPath: "/api/workspaces/name",
			Action: "workspace_renamed", Message: workspaceAuditMessage("重命名工作空间", name),
		})
	})
	if err != nil {
		return workspaceFailure(err)
	}
	return s.workspacesResult(r.Context(), acc)
}

func workspaceAuditMessage(summary, name string) string {
	raw, _ := json.Marshal(struct {
		Summary string `json:"summary"`
		Name    string `json:"name"`
	}{Summary: summary, Name: name})
	return string(raw)
}

// DissolveWorkspace is POST /api/workspaces/dissolve. The sequence mirrors the
// super-admin dissolve: settle the wallet and pending payment orders, retire
// credentials and stores, revoke invitations, then soft-delete the workspace.
// The row is kept for audit history; organization_members is deleted so seats
// are released.
func (s *Service) DissolveWorkspace(r *http.Request) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	if acc.orgID <= 0 {
		return authResult(http.StatusForbidden, msgNoWorkspace, "FORBIDDEN")
	}
	var body workspaceNameRequest
	if err := strictJSON(r, &body); err != nil {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	confirmName := strings.TrimSpace(body.Name)
	err := s.inOrgTx(r.Context(), acc.orgID, func(tx pgx.Tx, q *sqlc.Queries) (bool, error) {
		ctx := r.Context()
		var current string
		err := tx.QueryRow(ctx, `SELECT name FROM organizations WHERE id=$1 AND dissolved_at IS NULL FOR NO KEY UPDATE`, acc.orgID).Scan(&current)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, errWorkspaceNotFound
		}
		if err != nil {
			return false, err
		}
		var storedRole string
		err = tx.QueryRow(ctx, `SELECT role FROM organization_members WHERE org_id=$1 AND user_id=$2 AND status='active' AND NOT manual_disabled AND NOT quota_suspended FOR UPDATE`, acc.orgID, acc.id).Scan(&storedRole)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, errWorkspaceForbidden
		}
		if err != nil {
			return false, err
		}
		role, ok := access.ParseWorkspace(storedRole)
		if !ok || role != access.WorkspaceOwner {
			return false, errWorkspaceForbidden
		}
		if current != confirmName {
			return false, errWorkspaceDissolveName
		}
		rows, err := tx.Query(ctx, `SELECT id FROM org_invitations WHERE org_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL ORDER BY id FOR UPDATE`, acc.orgID)
		if err != nil {
			return false, err
		}
		for rows.Next() {
			var invitationID int64
			if err := rows.Scan(&invitationID); err != nil {
				rows.Close()
				return false, err
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return false, err
		}
		rows.Close()
		if _, err := tx.Exec(ctx, `INSERT INTO workspace_wallets (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING`, acc.orgID); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `SELECT 1 FROM workspace_wallets WHERE org_id=$1 FOR UPDATE`, acc.orgID); err != nil {
			return false, err
		}
		var held int64
		if err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(held_delta_microfen), 0)::bigint FROM wallet_ledger WHERE org_id=$1`, acc.orgID).Scan(&held); err != nil {
			return false, err
		}
		if held > 0 {
			return false, errWorkspaceBusy
		}
		pay, err := tx.Query(ctx, `SELECT id, provider FROM payment_orders WHERE org_id=$1 AND status='pending' FOR UPDATE`, acc.orgID)
		if err != nil {
			return false, err
		}
		for pay.Next() {
			var id int64
			var provider string
			if err := pay.Scan(&id, &provider); err != nil {
				pay.Close()
				return false, err
			}
			if provider != "manual" && provider != "unselected" {
				pay.Close()
				return false, errWorkspacePendingPayment
			}
		}
		if err := pay.Err(); err != nil {
			pay.Close()
			return false, err
		}
		pay.Close()
		if _, err := tx.Exec(ctx, `UPDATE payment_orders SET status='canceled', canceled_at=clock_timestamp(), qr_code=NULL, pay_url=NULL, updated_at=clock_timestamp() WHERE org_id=$1 AND status='pending'`, acc.orgID); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `UPDATE media_object_leases SET expires_at=LEAST(expires_at, clock_timestamp()), updated_at=clock_timestamp() WHERE org_id=$1 AND deleted_at IS NULL AND expires_at > clock_timestamp()`, acc.orgID); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM store_seller_credentials WHERE org_id=$1`, acc.orgID); err != nil {
			return false, err
		}
		nowMS := time.Now().UnixMilli()
		if _, err := tx.Exec(ctx, `UPDATE organization_stores SET deleted_at_ms=$1, assignee_membership_id=NULL, assignee_key_manage=false, assignee_key_read=false, assignee_key_write=false, assignee_key_edit=false, revision=revision+1, updated_at=clock_timestamp() WHERE org_id=$2 AND deleted_at_ms IS NULL`, nowMS, acc.orgID); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `UPDATE org_invitations SET revoked_at=clock_timestamp() WHERE org_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL`, acc.orgID); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `UPDATE organizations SET dissolved_at=clock_timestamp(), avatar_bytes=NULL, avatar_updated_at_ms=NULL, updated_at=clock_timestamp() WHERE id=$1 AND dissolved_at IS NULL`, acc.orgID); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM organization_members WHERE org_id=$1`, acc.orgID); err != nil {
			return false, err
		}
		if err := q.InsertAudit(ctx, sqlc.InsertAuditParams{
			OrgID: acc.orgID, UserID: acc.id, Module: "auth", EntityType: "workspace",
			EntityID: itoa(acc.orgID), ApiMethod: "POST", ApiPath: "/api/workspaces/dissolve",
			Action: "workspace_dissolved", Message: workspaceAuditMessage("解散工作空间 "+current, current),
		}); err != nil {
			return false, err
		}
		next, err := nextActiveOrg(ctx, tx, acc.id)
		if err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `UPDATE account_users SET active_org_id=$1, updated_at=clock_timestamp() WHERE id=$2`, next, acc.id); err != nil {
			return false, err
		}
		return true, nil
	})
	if err != nil {
		return workspaceFailure(err)
	}
	acc.orgID = 0
	return s.workspacesResult(r.Context(), acc)
}

// LeaveWorkspace is POST /api/workspaces/leave. Without workspace_id it
// targets the Active Workspace. A degraded session with no usable workspace
// may still hold suspended seats; exactly one suspended seat is unambiguous,
// more than one requires the caller to name it.
func (s *Service) LeaveWorkspace(r *http.Request) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	var body leaveWorkspaceRequest
	if err := decodeOptionalWorkspaceJSON(r, &body); err != nil {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	target := int64(0)
	if body.WorkspaceID != nil {
		if *body.WorkspaceID <= 0 {
			return authResult(http.StatusBadRequest, msgBadWorkspace, "VALIDATION")
		}
		target = *body.WorkspaceID
	} else if acc.orgID > 0 {
		target = acc.orgID
	} else {
		var suspended []sqlc.ListUnusableWorkspacesRow
		err := s.withQueries(r.Context(), func(q *sqlc.Queries) error {
			var err error
			suspended, err = q.ListUnusableWorkspaces(r.Context(), acc.id)
			return err
		})
		if err != nil {
			return dbResult(err)
		}
		switch len(suspended) {
		case 0:
			return authResult(http.StatusForbidden, errWorkspaceNoSeat.Error(), "FORBIDDEN")
		case 1:
			target = suspended[0].ID
		default:
			return workspaceFailure(errWorkspaceSeatAmbiguous)
		}
	}
	var next int64
	err := s.inOrgTx(r.Context(), target, func(tx pgx.Tx, q *sqlc.Queries) (bool, error) {
		ctx := r.Context()
		if err := lockWorkspace(ctx, tx, target); err != nil {
			return false, err
		}
		var membershipID, userID int64
		var storedRole string
		err := tx.QueryRow(ctx, `SELECT id, user_id, role FROM organization_members WHERE org_id=$1 AND user_id=$2 FOR UPDATE`, target, acc.id).Scan(&membershipID, &userID, &storedRole)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, errWorkspaceMemberMissing
		}
		if err != nil {
			return false, err
		}
		role, ok := access.ParseWorkspace(storedRole)
		if !ok {
			return false, errWorkspaceForbidden
		}
		if role == access.WorkspaceOwner {
			return false, errWorkspaceOwnerLeave
		}
		if _, err := tx.Exec(ctx, `UPDATE organization_stores SET assignee_membership_id=NULL, assignee_key_manage=false, assignee_key_read=false, assignee_key_write=false, assignee_key_edit=false, revision=revision+1, updated_at=clock_timestamp() WHERE org_id=$1 AND assignee_membership_id=$2`, target, membershipID); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM organization_members WHERE id=$1 AND org_id=$2`, membershipID, target); err != nil {
			return false, err
		}
		next, err = nextActiveOrg(ctx, tx, acc.id)
		if err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `UPDATE account_users SET active_org_id=$1, updated_at=clock_timestamp() WHERE id=$2`, next, acc.id); err != nil {
			return false, err
		}
		return true, q.InsertAudit(ctx, sqlc.InsertAuditParams{
			OrgID: target, UserID: acc.id, Module: "auth", EntityType: "workspace",
			EntityID: itoa(target), ApiMethod: "POST", ApiPath: "/api/workspaces/leave",
			Action: "workspace_left", Message: workspaceAuditMessage("退出工作空间", ""),
		})
	})
	if err != nil {
		return workspaceFailure(err)
	}
	if acc.orgID == target {
		acc.orgID = next
	}
	return s.workspacesResult(r.Context(), acc)
}

// RemoveWorkspaceMember is DELETE /api/workspaces/members/{id}. Stores assigned
// to the departing member stay in the workspace and become unassigned; the
// membership row is deleted so the seat is released.
func (s *Service) RemoveWorkspaceMember(r *http.Request, membershipID int64) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	if acc.orgID <= 0 {
		return authResult(http.StatusForbidden, msgNoWorkspace, "FORBIDDEN")
	}
	if membershipID <= 0 {
		return authResult(http.StatusBadRequest, errWorkspaceMemberMissing.Error(), "VALIDATION")
	}
	var targetUserID int64
	err := s.inOrgTx(r.Context(), acc.orgID, func(tx pgx.Tx, q *sqlc.Queries) (bool, error) {
		ctx := r.Context()
		if err := lockWorkspace(ctx, tx, acc.orgID); err != nil {
			return false, err
		}
		var actorStored string
		err := tx.QueryRow(ctx, `SELECT role FROM organization_members WHERE org_id=$1 AND user_id=$2 AND status='active' AND NOT manual_disabled AND NOT quota_suspended FOR UPDATE`, acc.orgID, acc.id).Scan(&actorStored)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, errWorkspaceForbidden
		}
		if err != nil {
			return false, err
		}
		var targetStored string
		err = tx.QueryRow(ctx, `SELECT user_id, role FROM organization_members WHERE org_id=$1 AND id=$2 FOR UPDATE`, acc.orgID, membershipID).Scan(&targetUserID, &targetStored)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, errWorkspaceMemberMissing
		}
		if err != nil {
			return false, err
		}
		actor, actorOK := access.ParseWorkspace(actorStored)
		target, targetOK := access.ParseWorkspace(targetStored)
		if !actorOK || !targetOK {
			return false, errWorkspaceForbidden
		}
		if !actor.MayRemoveMember(target, targetUserID == acc.id) {
			return false, errWorkspaceForbidden
		}
		if _, err := tx.Exec(ctx, `UPDATE organization_stores SET assignee_membership_id=NULL, assignee_key_manage=false, assignee_key_read=false, assignee_key_write=false, assignee_key_edit=false, revision=revision+1, updated_at=clock_timestamp() WHERE org_id=$1 AND assignee_membership_id=$2`, acc.orgID, membershipID); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM organization_members WHERE id=$1 AND org_id=$2`, membershipID, acc.orgID); err != nil {
			return false, err
		}
		next, err := nextActiveOrg(ctx, tx, targetUserID)
		if err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `UPDATE account_users SET active_org_id=$1, updated_at=clock_timestamp() WHERE id=$2 AND active_org_id=$3`, next, targetUserID, acc.orgID); err != nil {
			return false, err
		}
		return true, q.InsertAudit(ctx, sqlc.InsertAuditParams{
			OrgID: acc.orgID, UserID: acc.id, Module: "auth", EntityType: "workspace_member",
			EntityID: itoa(membershipID), ApiMethod: "DELETE", ApiPath: "/api/workspaces/members/" + itoa(membershipID),
			Action: "workspace_member_removed", Message: workspaceAuditMessage("移除工作空间成员", ""),
		})
	})
	if err != nil {
		return workspaceFailure(err)
	}
	return Result{Status: http.StatusOK, Body: okWorkspaceBody()}
}

// ChangeWorkspaceMemberRole is PUT /api/workspaces/members/{id}/role. The role
// vocabulary is the stored one: manager and member only; owner is immutable.
func (s *Service) ChangeWorkspaceMemberRole(r *http.Request, membershipID int64) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	if acc.orgID <= 0 {
		return authResult(http.StatusForbidden, msgNoWorkspace, "FORBIDDEN")
	}
	if membershipID <= 0 {
		return authResult(http.StatusBadRequest, errWorkspaceMemberMissing.Error(), "VALIDATION")
	}
	var body workspaceMemberRoleRequest
	if err := strictJSON(r, &body); err != nil {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	requested, ok := access.ParseWorkspace(body.Role)
	if !ok || requested == access.WorkspaceOwner {
		return authResult(http.StatusBadRequest, errWorkspaceRoleInvalid.Error(), "VALIDATION")
	}
	err := s.inOrgTx(r.Context(), acc.orgID, func(tx pgx.Tx, q *sqlc.Queries) (bool, error) {
		ctx := r.Context()
		if err := lockWorkspace(ctx, tx, acc.orgID); err != nil {
			return false, err
		}
		var actorStored string
		err := tx.QueryRow(ctx, `SELECT role FROM organization_members WHERE org_id=$1 AND user_id=$2 AND status='active' AND NOT manual_disabled AND NOT quota_suspended FOR UPDATE`, acc.orgID, acc.id).Scan(&actorStored)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, errWorkspaceForbidden
		}
		if err != nil {
			return false, err
		}
		var targetUserID int64
		var targetStored string
		err = tx.QueryRow(ctx, `SELECT user_id, role FROM organization_members WHERE org_id=$1 AND id=$2 FOR UPDATE`, acc.orgID, membershipID).Scan(&targetUserID, &targetStored)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, errWorkspaceMemberMissing
		}
		if err != nil {
			return false, err
		}
		actor, actorOK := access.ParseWorkspace(actorStored)
		target, targetOK := access.ParseWorkspace(targetStored)
		if !actorOK || !targetOK {
			return false, errWorkspaceForbidden
		}
		if !actor.MayChangeRole(target, targetUserID == acc.id) {
			return false, errWorkspaceForbidden
		}
		allowed := false
		for _, candidate := range actor.AssignableRoles(target, targetUserID == acc.id) {
			if candidate == string(requested) {
				allowed = true
				break
			}
		}
		if !allowed {
			return false, errWorkspaceRoleInvalid
		}
		if _, err := tx.Exec(ctx, `UPDATE organization_members SET role=$1, updated_at=clock_timestamp() WHERE id=$2 AND org_id=$3`, string(requested), membershipID, acc.orgID); err != nil {
			return false, err
		}
		return true, q.InsertAudit(ctx, sqlc.InsertAuditParams{
			OrgID: acc.orgID, UserID: acc.id, Module: "auth", EntityType: "workspace_member",
			EntityID: itoa(membershipID), ApiMethod: "PUT", ApiPath: "/api/workspaces/members/" + itoa(membershipID) + "/role",
			Action: "workspace_member_role_changed", Message: workspaceAuditMessage("调整工作空间成员角色", string(requested)),
		})
	})
	if err != nil {
		return workspaceFailure(err)
	}
	return Result{Status: http.StatusOK, Body: okWorkspaceBody()}
}

func okWorkspaceBody() []byte {
	return []byte(`{"data":{"ok":true}}`)
}
