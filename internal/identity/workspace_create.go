package identity

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

const workspaceNameMaxChars = 64

var errOwnedLimit = errors.New("owned workspace limit")

func validateWorkspaceName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || len([]rune(name)) > workspaceNameMaxChars {
		return "", fmt.Errorf("工作空间名称须为 1-%d 个字符", workspaceNameMaxChars)
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", errors.New("工作空间名称不能包含控制字符")
		}
	}
	if hasBannedTerm(name) {
		return "", errors.New("工作空间名称包含违规内容，请更换后重试")
	}
	return name, nil
}

type createWorkspaceWire struct {
	Data struct {
		Workspace   workspaceWire   `json:"workspace"`
		Workspaces  []workspaceWire `json:"workspaces"`
		AccountMode string          `json:"account_mode"`
		OwnedCount  int64           `json:"owned_count"`
		OwnedLimit  int64           `json:"owned_limit"`
	} `json:"data"`
}

// CreateWorkspace is POST /api/workspaces. The caller becomes owner of a new
// Free workspace and it becomes the Active Workspace. The account row lock
// serialises concurrent creates, so the owned-count check cannot be raced past
// the cap.
func (s *Service) CreateWorkspace(r *http.Request) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	if IsSupplierAccount(acc.accountKind) {
		return authResult(http.StatusForbidden, "供应商账号不能创建工作空间", "FORBIDDEN")
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := strictJSON(r, &body); err != nil {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	name, err := validateWorkspaceName(body.Name)
	if err != nil {
		return authResult(http.StatusBadRequest, err.Error(), "VALIDATION")
	}
	var orgID, ownedBefore int64
	err = s.inTx(r.Context(), func(tx pgx.Tx, q *sqlc.Queries) (bool, error) {
		ctx := r.Context()
		if _, err := q.LockAccount(ctx, acc.id); err != nil {
			return false, err
		}
		standing, err := q.AccountStanding(ctx, acc.id)
		if err != nil {
			return false, err
		}
		if standing.OwnedCount >= maxOwnedWorkspaces {
			ownedBefore = standing.OwnedCount
			return true, errOwnedLimit
		}
		if _, err := q.PlanActive(ctx, "free"); err != nil {
			return false, err
		}
		orgID, err = q.InsertOrganization(ctx, sqlc.InsertOrganizationParams{
			OwnerUserID: acc.id, Name: name, Plan: "free",
		})
		if err != nil {
			return false, err
		}
		if err := insertFreeSubscription(ctx, tx, q, orgID); err != nil {
			return false, err
		}
		if _, err := q.LockOrganization(ctx, orgID); err != nil {
			return false, err
		}
		order, err := q.NextJoinOrder(ctx, orgID)
		if err != nil {
			return false, err
		}
		if err := q.AttachOwner(ctx, sqlc.AttachOwnerParams{
			OrgID: orgID, UserID: acc.id, JoinOrder: order, DisplayName: acc.name,
		}); err != nil {
			return false, err
		}
		if err := q.SetActiveOrg(ctx, sqlc.SetActiveOrgParams{ActiveOrgID: pgtype.Int8{Int64: orgID, Valid: true}, ID: acc.id}); err != nil {
			return false, err
		}
		message, _ := json.Marshal(struct {
			Summary     string `json:"summary"`
			WorkspaceID int64  `json:"workspace_id"`
		}{Summary: fmt.Sprintf("创建工作空间 %d", orgID), WorkspaceID: orgID})
		return true, q.InsertAudit(ctx, sqlc.InsertAuditParams{
			OrgID: orgID, UserID: acc.id, Module: "auth", EntityType: "workspace",
			EntityID: itoa(orgID), ApiMethod: "POST", ApiPath: "/api/workspaces",
			Action: "workspace_created", Message: string(message),
		})
	})
	if errors.Is(err, errOwnedLimit) {
		return authResult(http.StatusBadRequest, workspaceLimitMessage(ownedBefore, maxOwnedWorkspaces), "WORKSPACE_LIMIT_REACHED")
	}
	if err != nil {
		return dbResult(err)
	}

	var rows []sqlc.ListWorkspacesRow
	var standing sqlc.AccountStandingRow
	err = s.withQueries(r.Context(), func(q *sqlc.Queries) error {
		var err error
		if rows, err = q.ListWorkspaces(r.Context(), acc.id); err != nil {
			return err
		}
		standing, err = q.AccountStanding(r.Context(), acc.id)
		return err
	})
	if err != nil {
		return dbResult(err)
	}
	var out createWorkspaceWire
	out.Data.Workspaces = make([]workspaceWire, 0, len(rows))
	for _, row := range rows {
		w := workspaceFrom(row.ID, row.Uuid, row.Name, row.Plan, row.Role, row.IsOwned, row.MemberCount, row.AvatarRevision)
		out.Data.Workspaces = append(out.Data.Workspaces, w)
		if row.ID == orgID {
			out.Data.Workspace = w
		}
	}
	out.Data.AccountMode = projectAccountMode(standing.OwnedCount, standing.MembershipCount)
	out.Data.OwnedCount = standing.OwnedCount
	out.Data.OwnedLimit = maxOwnedWorkspaces
	raw, err := json.Marshal(out)
	if err != nil {
		return dbResult(err)
	}
	return Result{Status: http.StatusOK, Body: raw}
}
