package identity

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

func (s *Service) sessionBody(ctx context.Context, token string, acc account) ([]byte, error) {
	var workspaces []sqlc.ListWorkspacesRow
	var unusable []sqlc.ListUnusableWorkspacesRow
	var standing sqlc.AccountStandingRow
	var marks sqlc.ProfileMarksRow
	err := s.withQueries(ctx, func(q *sqlc.Queries) error {
		var err error
		workspaces, err = q.ListWorkspaces(ctx, acc.id)
		if err != nil {
			return err
		}
		unusable, err = q.ListUnusableWorkspaces(ctx, acc.id)
		if err != nil {
			return err
		}
		standing, err = q.AccountStanding(ctx, acc.id)
		if err != nil {
			return err
		}
		marks, err = q.ProfileMarks(ctx, acc.id)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	wires := make([]workspaceWire, 0, len(workspaces))
	for _, row := range workspaces {
		wires = append(wires, workspaceFrom(row.ID, row.Uuid, row.Name, row.Plan, row.Role, row.IsOwned, row.MemberCount, row.AvatarRevision))
	}
	unusableWires := make([]workspaceWire, 0, len(unusable))
	for _, row := range unusable {
		unusableWires = append(unusableWires, workspaceFrom(row.ID, row.Uuid, row.Name, row.Plan, row.Role, row.IsOwned, row.MemberCount, row.AvatarRevision))
	}
	var active *workspaceWire
	for i := range wires {
		if wires[i].ID == acc.orgID {
			copy := wires[i]
			active = &copy
			break
		}
	}
	if active == nil && len(wires) > 0 {
		copy := wires[0]
		active = &copy
	}
	admin := access.IsPlatformStaff(acc.role)
	mode := projectAccountMode(standing.OwnedCount, standing.MembershipCount)
	kind := AccountKindFromStored(acc.accountKind)
	data := sessionDataWire{
		Authenticated:      true,
		IsAdmin:            &admin,
		UUID:               &acc.publicID,
		Email:              &acc.email,
		Name:               &acc.name,
		Role:               &acc.role,
		SupplierID:         &acc.supplierID,
		ActiveWorkspace:    active,
		Workspaces:         wires,
		UnusableWorkspaces: unusableWires,
		AccountMode:        &mode,
		AvatarRevision:     asInt64Ptr(marks.AvatarRevision),
		NameChangedAtMS:    pgInt(marks.NameChangedAtMs),
		AccountKind:        kind,
		MustChangePassword: acc.mustChangePassword,
	}
	raw, err := json.Marshal(sessionWire{Data: data})
	return raw, err
}

func workspaceFrom(id int64, uuid, name, plan, role string, owned bool, members int64, avatar any) workspaceWire {
	return workspaceWire{
		ID: id, UUID: uuid, Name: name, Plan: plan, Role: role,
		IsOwned: owned, MemberCount: members, AvatarRevision: asInt64Ptr(avatar),
	}
}

func (s *Service) issue(ctx context.Context, q *sqlc.Queries, userID int64, role, token, method, path, action, message string, orgID int64) error {
	expires := time.Now().UTC().Add(sessionTTL(role)).Format(time.RFC3339Nano)
	if err := q.IssueSession(ctx, sqlc.IssueSessionParams{TokenHash: hashToken(token), UserID: userID, Column3: expires}); err != nil {
		return err
	}
	if err := q.TouchLastLogin(ctx, userID); err != nil {
		return err
	}
	return q.InsertAudit(ctx, sqlc.InsertAuditParams{
		OrgID: orgID, UserID: userID, Module: "auth", EntityType: "session",
		EntityID: itoa(userID), ApiMethod: method, ApiPath: path, Action: action, Message: message,
	})
}

func sessionTTL(role string) time.Duration {
	if access.IsSuperAdmin(role) {
		return 8 * time.Hour
	}
	return 7 * 24 * time.Hour
}

func (s *Service) Session(r *http.Request) Result {
	if s.pool == nil {
		return Result{Status: http.StatusOK, Body: anonymousSessionBody()}
	}
	_, token, acc, err := s.resolveRequest(r)
	if err != nil {
		return dbResult(err)
	}
	if token == "" {
		return Result{Status: http.StatusOK, Body: anonymousSessionBody()}
	}
	body, err := s.sessionBody(r.Context(), token, acc)
	if err != nil {
		return dbResult(err)
	}
	return Result{Status: http.StatusOK, Body: body}
}

func (s *Service) Me(r *http.Request) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	return Result{Status: http.StatusOK, Body: meBody(acc.publicID, acc.role, acc.email, acc.name, acc.supplierID)}
}
