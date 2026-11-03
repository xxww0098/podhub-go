package identity

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	idservice "github.com/xxww0098/podhub-go/internal/identity/service"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

func (s *Service) Handoff(r *http.Request) Result {
	_, token, _, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	code, err := randomToken()
	if err != nil {
		return dbResult(err)
	}
	s.handoff.put(code, token, time.Now().Add(60*time.Second))
	return Result{Status: http.StatusOK, Body: handoffBody(code)}
}

func (s *Service) SwitchWorkspace(r *http.Request) Result {
	_, token, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	var body struct {
		WorkspaceID int64 `json:"workspace_id"`
	}
	if err := strictJSON(r, &body); err != nil {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	if body.WorkspaceID <= 0 {
		return authResult(http.StatusBadRequest, msgBadWorkspace, "VALIDATION")
	}
	var rows []sqlc.ListWorkspacesRow
	err := s.withQueries(r.Context(), func(q *sqlc.Queries) error {
		var err error
		rows, err = q.ListWorkspaces(r.Context(), acc.id)
		return err
	})
	if err != nil {
		return dbResult(err)
	}
	found := false
	for _, row := range rows {
		if row.ID == body.WorkspaceID {
			found = true
			break
		}
	}
	if !found {
		return authResult(http.StatusForbidden, msgNoSwitch, "FORBIDDEN")
	}
	err = s.inTx(r.Context(), func(_ pgx.Tx, q *sqlc.Queries) (bool, error) {
		if err := q.SetActiveOrg(r.Context(), sqlc.SetActiveOrgParams{ActiveOrgID: pgtype.Int8{Int64: body.WorkspaceID, Valid: true}, ID: acc.id}); err != nil {
			return false, err
		}
		message, _ := json.Marshal(struct {
			Summary     string `json:"summary"`
			WorkspaceID int64  `json:"workspace_id"`
		}{Summary: fmt.Sprintf("切换 Active Workspace 到 %d", body.WorkspaceID), WorkspaceID: body.WorkspaceID})
		return true, q.InsertAudit(r.Context(), sqlc.InsertAuditParams{
			OrgID: body.WorkspaceID, UserID: acc.id, Module: "auth", EntityType: "session",
			EntityID: itoa(acc.id), ApiMethod: "POST", ApiPath: "/api/workspaces/switch",
			Action: "active_workspace_switched", Message: string(message),
		})
	})
	if err != nil {
		return dbResult(err)
	}
	acc.orgID = body.WorkspaceID
	raw, err := s.sessionBody(r.Context(), token, acc)
	if err != nil {
		return dbResult(err)
	}
	return Result{Status: http.StatusOK, Body: raw}
}

func (s *Service) Members(r *http.Request) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	if acc.orgID <= 0 {
		return authResult(http.StatusForbidden, msgNoWorkspace, "FORBIDDEN")
	}
	ctx := r.Context()
	var rows []sqlc.DirectoryMembersRow
	var invites []sqlc.DirectoryInvitationsRow
	err := db.InTx(ctx, s.pool, db.App(acc.orgID), func(tx pgx.Tx) error {
		q := sqlc.New(tx)
		var err error
		if rows, err = q.DirectoryMembers(ctx, acc.orgID); err != nil {
			return err
		}
		invites, err = q.DirectoryInvitations(ctx, acc.orgID)
		return err
	})
	if err != nil {
		return dbResult(err)
	}
	actorRole, okRole := access.ParseWorkspace(memberRole(rows, acc.id))
	if !okRole {
		return authResult(http.StatusForbidden, msgBadRole, "FORBIDDEN")
	}
	var seatsUsed int64
	members := make([]directoryMember, 0, len(rows))
	for _, row := range rows {
		status := idservice.MembershipDirectoryStatus("active", row.ManualDisabled, row.QuotaSuspended)
		if status == "active" {
			seatsUsed++
		}
		target, _ := access.ParseWorkspace(row.Role)
		isSelf := row.UserID == acc.id
		members = append(members, directoryMember{
			ID: row.ID, Name: row.DisplayName, Email: row.Email, Role: row.Role,
			Status: status, JoinedAtMS: row.JoinedAtMs,
			Permissions: directoryMemberPerms{
				ChangeRoles: actorRole.AssignableRoles(target, isSelf),
				Remove:      actorRole.MayRemoveMember(target, isSelf),
			},
		})
	}
	pending := make([]directoryInvitation, 0, len(invites))
	for _, row := range invites {
		pending = append(pending, directoryInvitation{
			ID: row.ID, UUID: row.Uuid, Email: row.Email, Role: row.Role,
			InvitedByEmail: row.InvitedByEmail, CreatedAtMS: row.CreatedAtMs, ExpiresAtMS: row.ExpiresAtMs,
		})
	}
	invite := make([]string, 0, 2)
	for _, target := range []access.WorkspaceRole{access.WorkspaceManager, access.WorkspaceMember} {
		if actorRole.MayInvite(target) {
			invite = append(invite, string(target))
		}
	}
	raw, _ := json.Marshal(directoryWire{Data: directoryData{
		Invitations:  pending,
		Members:      members,
		PendingLimit: idservice.PendingInviteLimit,
		PendingUsed:  int64(len(pending)),
		Permissions: directoryPerms{
			Dissolve:         actorRole == access.WorkspaceOwner,
			EditProfile:      actorRole == access.WorkspaceOwner,
			InviteRoles:      invite,
			Leave:            actorRole != access.WorkspaceOwner,
			RevokeInvitation: actorRole.CanManage(),
		},
		SeatsUsed: seatsUsed,
	}})
	return Result{Status: http.StatusOK, Body: raw}
}

func memberRole(rows []sqlc.DirectoryMembersRow, userID int64) string {
	for _, row := range rows {
		if row.UserID == userID {
			return row.Role
		}
	}
	return ""
}
