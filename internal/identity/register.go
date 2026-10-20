package identity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

func (s *Service) Register(r *http.Request) Result {
	if s.pool == nil {
		return dbResult(errors.New("no pool"))
	}
	if !s.acquirePassword() {
		return authResult(http.StatusTooManyRequests, msgBusyHash, "RATE_LIMITED")
	}
	defer s.releasePassword()
	var body struct {
		Email      string  `json:"email"`
		Password   string  `json:"password"`
		Name       *string `json:"name"`
		InviteCode *string `json:"inviteCode"`
	}
	if err := strictJSON(r, &body); err != nil {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	email := strings.TrimSpace(body.Email)
	if body.InviteCode != nil && strings.TrimSpace(*body.InviteCode) != "" {
		return authResult(http.StatusBadRequest, msgInvite, "VALIDATION")
	}
	if !EmailShaped(email) || utf8.RuneCountInString(body.Password) < 8 || len(body.Password) > maxPasswordBytes {
		return authResult(http.StatusBadRequest, msgBadCredential, "VALIDATION")
	}
	name := email
	if body.Name != nil && strings.TrimSpace(*body.Name) != "" {
		name = strings.TrimSpace(*body.Name)
	}
	ip := ClientIP(r.Header)
	if wait, err := s.waiting(r.Context(), email, ip); err != nil {
		return dbResult(err)
	} else if wait {
		return authResult(http.StatusTooManyRequests, msgThrottle, "RATE_LIMITED")
	}
	hash, err := hashPassword(body.Password)
	if err != nil {
		return dbResult(err)
	}
	publicID, err := newPublicID()
	if err != nil {
		return dbResult(err)
	}
	token, err := s.sessionToken(r, hash)
	if err != nil {
		return dbResult(err)
	}
	var created sqlc.InsertAccountUserRow
	var replay bool
	err = s.inTx(r.Context(), func(q *sqlc.Queries) (bool, error) {
		ready, err := q.PlatformReady(r.Context())
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && !ready) {
			return true, errNotReady
		}
		if err != nil {
			return false, err
		}
		row, err := q.InsertAccountUser(r.Context(), sqlc.InsertAccountUserParams{
			PublicID: publicID, Email: email, PasswordHash: hash, Name: name,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			replay = true
			return true, errRegistered
		}
		if err != nil {
			return false, err
		}
		created = row
		orgID, err := s.bootstrap(r.Context(), q, row.ID, email, row.Name)
		if err != nil {
			return false, err
		}
		bound, err := q.BindInvitations(r.Context(), sqlc.BindInvitationsParams{
			InviteeUserID: pgtype.Int8{Int64: row.ID, Valid: true}, Lower: email,
		})
		if err != nil {
			return false, err
		}
		if err := q.IssueSession(r.Context(), sqlc.IssueSessionParams{
			TokenHash: hashToken(token), UserID: row.ID, Column3: time.Now().UTC().Add(sessionTTL(row.Role)).Format(time.RFC3339Nano),
		}); err != nil {
			return false, err
		}
		if err := q.TouchLastLogin(r.Context(), row.ID); err != nil {
			return false, err
		}
		message, _ := json.Marshal(struct {
			Summary              string `json:"summary"`
			Email                string `json:"email"`
			WorkspaceID          int64  `json:"workspace_id"`
			PendingInvitations   int64  `json:"pending_invitations"`
			InvitedByAgentUserID any    `json:"invited_by_agent_user_id"`
			AgentAttributionBPS  any    `json:"agent_attribution_bps"`
		}{
			Summary: fmt.Sprintf("注册账号 %s，开通免费工作空间 %d，回填待处理邀请 %d 条", row.Email, orgID, bound),
			Email:   row.Email, WorkspaceID: orgID, PendingInvitations: bound,
			InvitedByAgentUserID: nil, AgentAttributionBPS: nil,
		})
		if err := q.InsertAudit(r.Context(), sqlc.InsertAuditParams{
			OrgID: orgID, UserID: row.ID, Module: "auth", EntityType: "account",
			EntityID: row.PublicID, ApiMethod: "POST", ApiPath: "/api/auth/register",
			Action: "account_registered", Message: string(message),
		}); err != nil {
			return false, err
		}
		return true, nil
	})
	if errors.Is(err, errNotReady) {
		return authResult(http.StatusServiceUnavailable, msgNotInitialized, "WRITES_DISABLED")
	}
	if errors.Is(err, errRegistered) || replay {
		return s.registerReplay(r, email, body.Password, ip)
	}
	if err != nil {
		return dbResult(err)
	}
	cred := SessionCredentials(r.Header)
	live, err := s.liveStack(r.Context(), cred)
	if err != nil {
		return dbResult(err)
	}
	stack := MergedStack(live, created.ID, token)
	return Result{
		Status:  http.StatusOK,
		Body:    loginBody(token, created.PublicID, created.Role, created.Email, created.Name, created.SupplierID, created.Target),
		Cookies: SessionCookies(token, stack),
	}
}

func (s *Service) registerReplay(r *http.Request, email, password, ip string) Result {
	user, err := s.q(r.Context()).FindUserByEmail(r.Context(), email)
	if err != nil {
		return dbResult(err)
	}
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key != "" && verifyPassword(password, user.PasswordHash) {
		if user.Disabled {
			return authResult(http.StatusUnauthorized, msgDisabled, "AUTH_INVALID")
		}
		token := DeriveSessionToken(user.PasswordHash, key)
		cred := SessionCredentials(r.Header)
		live, err := s.liveStack(r.Context(), cred)
		if err != nil {
			return dbResult(err)
		}
		err = s.inTx(r.Context(), func(q *sqlc.Queries) (bool, error) {
			return true, s.issue(r.Context(), q, user.ID, user.Role, token, "POST", "/api/auth/login", "session_issued", `{"summary":"签发会话"}`, 0)
		})
		if err != nil {
			return dbResult(err)
		}
		stack := MergedStack(live, user.ID, token)
		return Result{
			Status:  http.StatusOK,
			Body:    loginBody(token, user.PublicID, user.Role, user.Email, user.Name, user.SupplierID, user.Target),
			Cookies: SessionCookies(token, stack),
		}
	}
	s.recordFailure(r.Context(), email, ip)
	return authResult(http.StatusBadRequest, msgRegistered, "VALIDATION")
}

func (s *Service) bootstrap(ctx context.Context, q *sqlc.Queries, userID int64, email, display string) (int64, error) {
	if _, err := q.LockAccount(ctx, userID); err != nil {
		return 0, err
	}
	orgID, err := q.FirstOwnedOrg(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		// New accounts start on free. A paid plan is bought, never defaulted:
		// registration used to create a lite workspace, which under the new
		// catalogue is a 100 yuan plan nobody asked for.
		if _, err := q.PlanActive(ctx, "free"); err != nil {
			return 0, err
		}
		orgID, err = q.InsertOrganization(ctx, sqlc.InsertOrganizationParams{
			OwnerUserID: userID, Name: defaultWorkspaceName(display, email), Plan: "free",
		})
		if err != nil {
			return 0, err
		}
		if err := insertFreeSubscription(ctx, q, orgID); err != nil {
			return 0, err
		}
	} else if err != nil {
		return 0, err
	}
	if _, err := q.LockOrganization(ctx, orgID); err != nil {
		return 0, err
	}
	order, err := q.NextJoinOrder(ctx, orgID)
	if err != nil {
		return 0, err
	}
	if err := q.AttachOwner(ctx, sqlc.AttachOwnerParams{
		OrgID: orgID, UserID: userID, JoinOrder: order, DisplayName: display,
	}); err != nil {
		return 0, err
	}
	if err := q.SetActiveOrg(ctx, sqlc.SetActiveOrgParams{ActiveOrgID: pgtype.Int8{Int64: orgID, Valid: true}, ID: userID}); err != nil {
		return 0, err
	}
	return orgID, nil
}

// insertFreeSubscription gives a new workspace its subscription row. Every
// projection and every quote locks this row, so a workspace without one is a
// 409 on the billing screen rather than a silently free tier.
func insertFreeSubscription(ctx context.Context, q *sqlc.Queries, orgID int64) error {
	return q.InsertFreeSubscription(ctx, orgID)
}

func defaultWorkspaceName(display, email string) string {
	label := strings.TrimSpace(strings.Split(display, "@")[0])
	if label == "" {
		parts := strings.Split(email, "@")
		if len(parts) > 0 {
			label = parts[0]
		}
	}
	if label == "" {
		label = "PodHub"
	}
	return label + " 的工作空间"
}
