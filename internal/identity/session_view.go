package identity

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

func (s *Service) sessionBody(ctx context.Context, cred Credentials, token string, acc account) ([]byte, error) {
	q := s.q(ctx)
	workspaces, err := q.ListWorkspaces(ctx, acc.id)
	if err != nil {
		return nil, err
	}
	unusable, err := q.ListUnusableWorkspaces(ctx, acc.id)
	if err != nil {
		return nil, err
	}
	standing, err := q.AccountStanding(ctx, acc.id)
	if err != nil {
		return nil, err
	}
	marks, err := q.ProfileMarks(ctx, acc.id)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	verified, err := q.EmailVerified(ctx, acc.id)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
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
	accounts, err := s.stackedAccounts(ctx, cred, token, acc, asInt64Ptr(marks.AvatarRevision))
	if err != nil {
		return nil, err
	}
	admin := RoleFromStored(acc.role).IsStaff()
	mode := projectAccountMode(standing.OwnedCount, standing.MembershipCount)
	data := sessionDataWire{
		Authenticated:      true,
		IsAdmin:            &admin,
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
		Accounts:           accounts,
	}
	if !verified {
		falsy := false
		data.EmailVerified = &falsy
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

func (s *Service) stackedAccounts(ctx context.Context, cred Credentials, token string, acc account, avatar *int64) ([]sessionAccountWire, error) {
	candidates := cred.StackCandidates()
	if len(candidates) == 0 {
		return []sessionAccountWire{{UUID: acc.publicID, Email: acc.email, Name: acc.name, Active: true, AvatarRevision: avatar}}, nil
	}
	hashes := make([]string, len(candidates))
	for i, item := range candidates {
		hashes[i] = hashToken(item)
	}
	rows, err := s.q(ctx).ResolveStacked(ctx, hashes)
	if err != nil {
		return nil, err
	}
	byHash := map[string]sqlc.ResolveStackedRow{}
	for _, row := range rows {
		byHash[row.TokenHash] = row
	}
	out := make([]sessionAccountWire, 0, len(candidates))
	activeSeen := false
	for _, item := range candidates {
		row, ok := byHash[hashToken(item)]
		if !ok {
			continue
		}
		active := item == token
		if active {
			activeSeen = true
		}
		out = append(out, sessionAccountWire{
			UUID: row.Uuid, Email: row.Email, Name: row.Name, Active: active,
			AvatarRevision: asInt64Ptr(row.AvatarRevision),
		})
	}
	if !activeSeen {
		out = append(out, sessionAccountWire{UUID: acc.publicID, Email: acc.email, Name: acc.name, Active: true, AvatarRevision: avatar})
	}
	return out, nil
}

func (s *Service) liveStack(ctx context.Context, cred Credentials) ([]StackEntry, error) {
	var out []StackEntry
	for _, token := range cred.Candidates() {
		acc, ok, err := s.resolveToken(ctx, token)
		if err != nil {
			return nil, err
		}
		if ok {
			out = append(out, StackEntry{Token: token, UserID: acc.id})
		}
	}
	return out, nil
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
	if RoleFromStored(role).IsSuperAdmin() {
		return 8 * time.Hour
	}
	return 7 * 24 * time.Hour
}

func (s *Service) Session(r *http.Request) Result {
	if s.pool == nil {
		return Result{Status: http.StatusOK, Body: anonymousSessionBody()}
	}
	cred, token, acc, err := s.resolveRequest(r)
	if err != nil {
		return dbResult(err)
	}
	if token == "" {
		return Result{Status: http.StatusOK, Body: anonymousSessionBody()}
	}
	body, err := s.sessionBody(r.Context(), cred, token, acc)
	if err != nil {
		return dbResult(err)
	}
	res := Result{Status: http.StatusOK, Body: body}
	if cred.Bearer == "" && cred.SID != token {
		res.Cookies = []string{SessionCookies(token, nil)[0]}
		// SessionCookies(token, nil) clears sids. Keep the stack cookie unchanged
		// and only re-point sid, matching with_promoted_sid.
		res.Cookies = []string{promotedSid(token)}
	}
	return res
}

func promotedSid(token string) string {
	return SessionCookie + "=" + token + "; Path=/; Max-Age=" + itoa(int64(sessionCookieMaxAge)) + "; HttpOnly; SameSite=Lax" + CookieSecureAttribute()
}

func (s *Service) Me(r *http.Request) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	return Result{Status: http.StatusOK, Body: meBody(acc.publicID, acc.role, acc.email, acc.name, acc.supplierID)}
}
