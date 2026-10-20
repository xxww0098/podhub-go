package identity

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
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
	cred, token, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	var body struct {
		ID int64 `json:"id"`
	}
	if err := strictJSON(r, &body); err != nil {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	if body.ID <= 0 {
		return authResult(http.StatusBadRequest, msgBadWorkspace, "VALIDATION")
	}
	rows, err := s.q(r.Context()).ListWorkspaces(r.Context(), acc.id)
	if err != nil {
		return dbResult(err)
	}
	found := false
	for _, row := range rows {
		if row.ID == body.ID {
			found = true
			break
		}
	}
	if !found {
		return authResult(http.StatusForbidden, msgNoSwitch, "FORBIDDEN")
	}
	err = s.inTx(r.Context(), func(q *sqlc.Queries) (bool, error) {
		if err := q.SetActiveOrg(r.Context(), sqlc.SetActiveOrgParams{ActiveOrgID: pgtype.Int8{Int64: body.ID, Valid: true}, ID: acc.id}); err != nil {
			return false, err
		}
		message, _ := json.Marshal(struct {
			Summary     string `json:"summary"`
			WorkspaceID int64  `json:"workspace_id"`
		}{Summary: fmt.Sprintf("切换 Active Workspace 到 %d", body.ID), WorkspaceID: body.ID})
		return true, q.InsertAudit(r.Context(), sqlc.InsertAuditParams{
			OrgID: body.ID, UserID: acc.id, Module: "auth", EntityType: "session",
			EntityID: itoa(acc.id), ApiMethod: "POST", ApiPath: "/api/workspaces/switch",
			Action: "active_workspace_switched", Message: string(message),
		})
	})
	if err != nil {
		return dbResult(err)
	}
	acc.orgID = body.ID
	raw, err := s.sessionBody(r.Context(), cred, token, acc)
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
	rows, err := s.q(r.Context()).DirectoryMembers(r.Context(), acc.orgID)
	if err != nil {
		return dbResult(err)
	}
	actorRole, okRole := ParseWorkspaceRole(memberRole(rows, acc.id))
	if !okRole {
		return authResult(http.StatusForbidden, msgBadRole, "FORBIDDEN")
	}
	members := make([]directoryMember, 0, len(rows))
	for _, row := range rows {
		members = append(members, directoryMember{
			ID: row.ID, Email: row.Email, Role: row.Role, DisplayName: row.DisplayName,
			Status: MembershipDirectoryStatus("active", row.ManualDisabled, row.QuotaSuspended),
		})
	}
	invite := make([]string, 0, 2)
	for _, target := range []WorkspaceRole{WorkspaceManager, WorkspaceOperator} {
		if actorRole.MayInvite(target) {
			invite = append(invite, target.Stored())
		}
	}
	raw, _ := json.Marshal(directoryWire{Data: directoryData{Members: members, Permissions: directoryPerms{InviteRoles: invite}}})
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
