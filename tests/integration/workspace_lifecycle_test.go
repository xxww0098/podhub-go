package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/app"
)

type workspaceListEnvelope struct {
	Data struct {
		Workspaces []struct {
			ID      int64  `json:"id"`
			Name    string `json:"name"`
			Role    string `json:"role"`
			IsOwned bool   `json:"is_owned"`
		} `json:"workspaces"`
		ActiveWorkspace *struct {
			ID   int64  `json:"id"`
			Name string `json:"name"`
		} `json:"active_workspace"`
		AccountMode string `json:"account_mode"`
		OwnedCount  int64  `json:"owned_count"`
		OwnedLimit  int64  `json:"owned_limit"`
	} `json:"data"`
}

func doWorkspaceRequest(t *testing.T, handler http.Handler, method, path, body, cookie string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func registerWorkspaceAccount(t *testing.T, handler http.Handler, email, name string) (string, int64) {
	t.Helper()
	rec := postJSON(t, handler, "/api/auth/register",
		fmt.Sprintf(`{"email":%q,"password":"workspace-test-pass-1","name":%q}`, email, name),
		"workspace-register-"+email, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("register %s: %d %s", email, rec.Code, rec.Body.String())
	}
	cookies := rec.Header().Values("Set-Cookie")
	if len(cookies) == 0 {
		t.Fatalf("register %s returned no cookie", email)
	}
	cookie := strings.Split(cookies[0], ";")[0]
	return cookie, workspaceIDForEmail(t, handler, cookie, email)
}

func workspaceIDForEmail(t *testing.T, handler http.Handler, cookie, email string) int64 {
	t.Helper()
	rec := get(t, handler, "/api/workspaces", cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("list workspaces for %s: %d %s", email, rec.Code, rec.Body.String())
	}
	var body workspaceListEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.ActiveWorkspace == nil {
		t.Fatalf("list workspaces for %s returned no active workspace", email)
	}
	return body.Data.ActiveWorkspace.ID
}

func TestWorkspaceLifecycleAndRoster(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "workspace-lifecycle-test-key")
	t.Setenv("CLOUD_COOKIE_SECURE", "0")

	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users
		    (public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ('00000000-0000-4000-8000-000000000010', 'bootstrap@workspace.example', 'x', 'super_admin', 'bootstrap', '/workspace', '', 'free', clock_timestamp(), clock_timestamp())`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE platform_initialization
		SET owner_account_id = (SELECT id FROM account_users WHERE email = 'bootstrap@workspace.example'),
		    initialized_at = clock_timestamp()
		WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	handler := app.Handler(pool)

	ownerCookie, ownerOrg := registerWorkspaceAccount(t, handler, "owner@workspace.example", "Owner")
	memberCookie, memberOrg := registerWorkspaceAccount(t, handler, "member@workspace.example", "Member")
	var memberID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM account_users WHERE email = 'member@workspace.example'`).Scan(&memberID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, join_order, display_name, created_at, updated_at)
		VALUES ($1, $2, 'member', 'active', 2, 'Member', clock_timestamp(), clock_timestamp())`, ownerOrg, memberID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE account_users SET active_org_id=$1, updated_at=clock_timestamp() WHERE id=$2`, ownerOrg, memberID); err != nil {
		t.Fatal(err)
	}

	// The SPA switches with workspace_id; both directions must move the active
	// organization and leave the UI's session reload consistent.
	rec := doWorkspaceRequest(t, handler, http.MethodPost, "/api/workspaces/switch", fmt.Sprintf(`{"workspace_id":%d}`, memberOrg), memberCookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("switch to own workspace: %d %s", rec.Code, rec.Body.String())
	}
	var switched int64
	if err := pool.QueryRow(ctx, `SELECT active_org_id FROM account_users WHERE id=$1`, memberID).Scan(&switched); err != nil || switched != memberOrg {
		t.Fatalf("active org after switch %d want %d err %v", switched, memberOrg, err)
	}
	rec = doWorkspaceRequest(t, handler, http.MethodPost, "/api/workspaces/switch", fmt.Sprintf(`{"workspace_id":%d}`, ownerOrg), memberCookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("switch back to owner workspace: %d %s", rec.Code, rec.Body.String())
	}

	// List and rename: the owner sees the workspace and the roster, a member
	// cannot change the workspace profile.
	rec = get(t, handler, "/api/workspaces", ownerCookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("owner list: %d %s", rec.Code, rec.Body.String())
	}
	var listed workspaceListEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Data.Workspaces) != 1 || listed.Data.Workspaces[0].Role != "owner" || listed.Data.OwnedLimit != 3 {
		t.Fatalf("owner list unexpected: %+v", listed)
	}
	rec = doWorkspaceRequest(t, handler, http.MethodPut, "/api/workspaces/name", `{"name":"Renamed"}`, ownerCookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("rename: %d %s", rec.Code, rec.Body.String())
	}
	var renamed string
	if err := pool.QueryRow(ctx, `SELECT name FROM organizations WHERE id=$1`, ownerOrg).Scan(&renamed); err != nil || renamed != "Renamed" {
		t.Fatalf("renamed %q err %v", renamed, err)
	}
	rec = doWorkspaceRequest(t, handler, http.MethodPut, "/api/workspaces/name", `{"name":"Nope"}`, memberCookie)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("member rename status %d: %s", rec.Code, rec.Body.String())
	}

	// Role changes are owner-only and limited to manager/member.
	var membershipID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM organization_members WHERE org_id=$1 AND user_id=$2`, ownerOrg, memberID).Scan(&membershipID); err != nil {
		t.Fatal(err)
	}
	rec = doWorkspaceRequest(t, handler, http.MethodPut, fmt.Sprintf("/api/workspaces/members/%d/role", membershipID), `{"role":"manager"}`, ownerCookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("promote: %d %s", rec.Code, rec.Body.String())
	}
	var storedRole string
	if err := pool.QueryRow(ctx, `SELECT role FROM organization_members WHERE id=$1`, membershipID).Scan(&storedRole); err != nil || storedRole != "manager" {
		t.Fatalf("role %q err %v", storedRole, err)
	}
	rec = doWorkspaceRequest(t, handler, http.MethodPut, fmt.Sprintf("/api/workspaces/members/%d/role", membershipID), `{"role":"member"}`, ownerCookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("demote: %d %s", rec.Code, rec.Body.String())
	}
	rec = doWorkspaceRequest(t, handler, http.MethodPut, fmt.Sprintf("/api/workspaces/members/%d/role", membershipID), `{"role":"owner"}`, ownerCookie)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("owner role assignment status %d: %s", rec.Code, rec.Body.String())
	}

	// Remove the member; the seat and the membership row go away.
	rec = doWorkspaceRequest(t, handler, http.MethodDelete, fmt.Sprintf("/api/workspaces/members/%d", membershipID), "", ownerCookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("remove member: %d %s", rec.Code, rec.Body.String())
	}
	var remaining int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM organization_members WHERE id=$1`, membershipID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("membership remaining %d err %v", remaining, err)
	}

	// Re-add the member and exercise leave without a body: the active workspace
	// is the owner workspace, so leave must resolve it on its own.
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, join_order, display_name, created_at, updated_at)
		VALUES ($1, $2, 'member', 'active', 2, 'Member', clock_timestamp(), clock_timestamp())`, ownerOrg, memberID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE account_users SET active_org_id=$1, updated_at=clock_timestamp() WHERE id=$2`, ownerOrg, memberID); err != nil {
		t.Fatal(err)
	}
	rec = doWorkspaceRequest(t, handler, http.MethodPost, "/api/workspaces/leave", "", memberCookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("leave: %d %s", rec.Code, rec.Body.String())
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM organization_members WHERE org_id=$1 AND user_id=$2`, ownerOrg, memberID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("membership after leave %d err %v", remaining, err)
	}
	var active int64
	if err := pool.QueryRow(ctx, `SELECT active_org_id FROM account_users WHERE id=$1`, memberID).Scan(&active); err != nil || active != memberOrg {
		t.Fatalf("member active org %d want %d err %v", active, memberOrg, err)
	}

	// Owner cannot leave; dissolve instead, and the owned workspace disappears
	// from the live list while the row remains for history.
	rec = doWorkspaceRequest(t, handler, http.MethodPost, "/api/workspaces/leave", "", ownerCookie)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("owner leave status %d: %s", rec.Code, rec.Body.String())
	}
	rec = postJSON(t, handler, "/api/workspaces", `{"name":"Temporary"}`, "workspace-create-temp", ownerCookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("create temporary: %d %s", rec.Code, rec.Body.String())
	}
	var created workspaceListEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	var tempID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM organizations WHERE name='Temporary' AND dissolved_at IS NULL ORDER BY id DESC LIMIT 1`).Scan(&tempID); err != nil {
		t.Fatal(err)
	}
	rec = doWorkspaceRequest(t, handler, http.MethodPost, "/api/workspaces/dissolve", `{"name":"Temporary"}`, ownerCookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("dissolve: %d %s", rec.Code, rec.Body.String())
	}
	var dissolved bool
	if err := pool.QueryRow(ctx, `SELECT dissolved_at IS NOT NULL FROM organizations WHERE id=$1`, tempID).Scan(&dissolved); err != nil || !dissolved {
		t.Fatalf("dissolved %v err %v", dissolved, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM organization_members WHERE org_id=$1`, tempID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("dissolved members %d err %v", remaining, err)
	}
	rec = get(t, handler, "/api/workspaces", ownerCookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("owner list after dissolve: %d %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	for _, workspace := range listed.Data.Workspaces {
		if workspace.ID == tempID {
			t.Fatalf("dissolved workspace %d still listed", tempID)
		}
	}
}
