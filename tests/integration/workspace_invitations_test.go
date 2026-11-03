package integration

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/app"
)

type invitationCreatedProof struct {
	UUID     string `json:"uuid"`
	Token    string `json:"token"`
	Email    string `json:"email"`
	Role     string `json:"role"`
	Notified bool   `json:"notified"`
}

func invitationLogin(t *testing.T, f identityRuntimeFixture, user int64) string {
	t.Helper()
	return identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", fmt.Sprintf(`{"email":"a%d@example.invalid","password":"original-password"}`, user), "", fmt.Sprintf("invitation-%d", user)))
}

func createInvitationProof(t *testing.T, f identityRuntimeFixture, owner, email, role string) invitationCreatedProof {
	t.Helper()
	response := f.request(http.MethodPost, "/api/invitations", fmt.Sprintf(`{"email":%q,"role":%q}`, email, role), owner, "")
	var invitation invitationCreatedProof
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &invitation) != nil || invitation.UUID == "" || len(invitation.Token) != 43 || invitation.Notified {
		t.Fatalf("create invitation: %d %s", response.Code, response.Body.String())
	}
	return invitation
}

func invitationProofBody(invitation invitationCreatedProof) string {
	return fmt.Sprintf(`{"token":%q}`, invitation.Token)
}

func TestWorkspaceInvitationsProductionRole(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	owner := invitationLogin(t, f, 96311)
	invitee := invitationLogin(t, f, 96312)
	invitation := createInvitationProof(t, f, owner, "A96312@example.invalid", "member")
	var orgID int64
	var digest, storedNotifications string
	if err := f.fixture.QueryRow(f.ctx, `SELECT org_id,token_hash,(SELECT payload::text FROM notifications WHERE invitation_id=i.id) FROM org_invitations i WHERE uuid=$1::uuid`, invitation.UUID).Scan(&orgID, &digest, &storedNotifications); err != nil || digest != sha256Hex(invitation.Token) || strings.Contains(storedNotifications, invitation.Token) {
		t.Fatalf("persisted proof digest=%q notification=%q err=%v", digest, storedNotifications, err)
	}
	for _, route := range []struct{ path, token string }{{"/api/workspaces/members", owner}, {"/api/notifications", invitee}} {
		response := f.request(http.MethodGet, route.path, "", route.token, "")
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), invitation.UUID) || strings.Contains(response.Body.String(), invitation.Token) || strings.Contains(response.Body.String(), digest) {
			t.Fatalf("safe invitation projection %s: %d %s", route.path, response.Code, response.Body.String())
		}
	}
	acceptPath := "/api/invitations/" + invitation.UUID + "/accept"
	for _, test := range []struct{ token, body string }{{owner, invitationProofBody(invitation)}, {invitee, `{"token":"` + strings.Repeat("x", 43) + `"}`}, {invitee, invitationProofBody(invitation) + ` {}`}, {invitee, `{"token":"` + invitation.Token + `","org_id":99}`}} {
		if response := f.request(http.MethodPost, acceptPath, test.body, test.token, ""); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid invitation proof: %d %s", response.Code, response.Body.String())
		}
	}
	if response := f.request(http.MethodPost, "/api/invitations", `{"email":"a96312@example.invalid","role":"member"}`, owner, ""); response.Code != http.StatusBadRequest {
		t.Fatalf("duplicate invite: %d %s", response.Code, response.Body.String())
	}
	for range 2 {
		if response := f.request(http.MethodPost, acceptPath, invitationProofBody(invitation), invitee, ""); response.Code != http.StatusOK {
			t.Fatalf("accept or replay: %d %s", response.Code, response.Body.String())
		}
	}
	var members, audits int
	var active int64
	var role string
	if err := f.fixture.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM organization_members WHERE org_id=$1 AND user_id=96312),
	 (SELECT count(*) FROM audit_logs WHERE entity_id=$2 AND action='workspace_invitation_accepted'),
	 (SELECT active_org_id FROM account_users WHERE id=96312),
	 (SELECT role FROM organization_members WHERE org_id=$1 AND user_id=96312)`, orgID, invitation.UUID).Scan(&members, &audits, &active, &role); err != nil || members != 1 || audits != 1 || active != orgID || role != "member" {
		t.Fatalf("accepted members=%d audits=%d active=%d role=%q err=%v", members, audits, active, role, err)
	}
	notifications := f.request(http.MethodGet, "/api/notifications", "", invitee, "")
	if !strings.Contains(notifications.Body.String(), `"status": "accepted"`) && !strings.Contains(notifications.Body.String(), `"status":"accepted"`) {
		t.Fatalf("accepted notification: %s", notifications.Body.String())
	}
	// A plain member cannot create an invitation, including a forged owner role.
	for _, role := range []string{"member", "manager", "owner"} {
		response := f.request(http.MethodPost, "/api/invitations", fmt.Sprintf(`{"email":"someone@example.invalid","role":%q}`, role), invitee, "")
		if response.Code != http.StatusForbidden && !(role == "owner" && response.Code == http.StatusBadRequest) {
			t.Fatalf("member invite %s: %d %s", role, response.Code, response.Body.String())
		}
	}
	f.assertClean(t)
}

func TestWorkspaceInvitationRegistrationDeclineRevokeAndExpiry(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	owner := invitationLogin(t, f, 96311)
	otherOwner := invitationLogin(t, f, 96312)
	invitation := createInvitationProof(t, f, owner, "before-registration@example.invalid", "member")
	registered := f.request(http.MethodPost, "/api/auth/register", `{"email":"BEFORE-registration@example.invalid","password":"original-password","name":"New member"}`, "", "invitation-registration")
	newUser := identityRuntimeToken(t, registered)
	notification := f.request(http.MethodGet, "/api/notifications", "", newUser, "")
	if notification.Code != http.StatusOK || !strings.Contains(notification.Body.String(), invitation.UUID) || strings.Contains(notification.Body.String(), invitation.Token) {
		t.Fatalf("registration notification: %d %s", notification.Code, notification.Body.String())
	}
	decline := "/api/invitations/" + invitation.UUID + "/decline"
	for range 2 {
		if response := f.request(http.MethodPost, decline, invitationProofBody(invitation), newUser, ""); response.Code != http.StatusOK {
			t.Fatalf("decline: %d %s", response.Code, response.Body.String())
		}
	}
	if response := f.request(http.MethodPost, "/api/invitations/"+invitation.UUID+"/accept", invitationProofBody(invitation), newUser, ""); response.Code != http.StatusBadRequest {
		t.Fatalf("accept declined: %d %s", response.Code, response.Body.String())
	}
	invitation = createInvitationProof(t, f, owner, "before-registration@example.invalid", "member")
	if response := f.request(http.MethodDelete, "/api/invitations/"+invitation.UUID, "", otherOwner, ""); response.Code != http.StatusBadRequest {
		t.Fatalf("cross-org revoke: %d %s", response.Code, response.Body.String())
	}
	for range 2 {
		if response := f.request(http.MethodDelete, "/api/invitations/"+invitation.UUID, "", owner, ""); response.Code != http.StatusOK {
			t.Fatalf("revoke: %d %s", response.Code, response.Body.String())
		}
	}
	if response := f.request(http.MethodGet, "/api/notifications", "", newUser, ""); strings.Contains(response.Body.String(), invitation.UUID) {
		t.Fatalf("revoked invitation still visible: %s", response.Body.String())
	}
	if response := f.request(http.MethodPost, "/api/invitations/"+invitation.UUID+"/accept", invitationProofBody(invitation), newUser, ""); response.Code != http.StatusBadRequest {
		t.Fatalf("accept revoked: %d %s", response.Code, response.Body.String())
	}
	invitation = createInvitationProof(t, f, owner, "before-registration@example.invalid", "member")
	if _, err := f.fixture.Exec(f.ctx, `UPDATE org_invitations SET expires_at=clock_timestamp()-interval '1 minute' WHERE uuid=$1::uuid`, invitation.UUID); err != nil {
		t.Fatal(err)
	}
	if response := f.request(http.MethodPost, "/api/invitations/"+invitation.UUID+"/accept", invitationProofBody(invitation), newUser, ""); response.Code != http.StatusBadRequest {
		t.Fatalf("accept expired: %d %s", response.Code, response.Body.String())
	}
	// Expired rows keep their proof history, while a new invitation gets a fresh proof.
	replacement := createInvitationProof(t, f, owner, "before-registration@example.invalid", "member")
	if replacement.UUID == invitation.UUID || replacement.Token == invitation.Token {
		t.Fatal("expired invitation identity or secret reused")
	}
	if _, err := f.fixture.Exec(f.ctx, `ALTER TABLE audit_logs ADD CONSTRAINT reject_invitation_accept_audit CHECK (action<>'workspace_invitation_accepted')`); err != nil {
		t.Fatal(err)
	}
	response := f.request(http.MethodPost, "/api/invitations/"+replacement.UUID+"/accept", invitationProofBody(replacement), newUser, "")
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("audit rollback: %d %s", response.Code, response.Body.String())
	}
	var member, accepted, read bool
	if err := f.fixture.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM organization_members m JOIN org_invitations i ON i.org_id=m.org_id WHERE i.uuid=$1::uuid AND m.user_id=i.invitee_user_id),i.accepted_at IS NOT NULL,n.read_at IS NOT NULL FROM org_invitations i JOIN notifications n ON n.invitation_id=i.id WHERE i.uuid=$1::uuid`, replacement.UUID).Scan(&member, &accepted, &read); err != nil || member || accepted || read {
		t.Fatalf("rollback member=%v accepted=%v read=%v err=%v", member, accepted, read, err)
	}
	f.assertClean(t)
}

func TestWorkspaceInvitationConcurrentSeatsAndRoleBounds(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	for _, id := range []int64{96313, 96314} {
		seedAITenant(t, f.ctx, f.fixture, id)
		if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET password_hash=(SELECT password_hash FROM account_users WHERE id=96311),public_id=gen_random_uuid()::text WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
	}
	owner := invitationLogin(t, f, 96311)
	manager := invitationLogin(t, f, 96312)
	a := invitationLogin(t, f, 96313)
	b := invitationLogin(t, f, 96314)
	var orgID int64
	if err := f.fixture.QueryRow(f.ctx, `SELECT org_id FROM organization_members WHERE user_id=96311 AND role='owner'`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO organization_members (org_id,user_id,role,status,display_name,join_order,created_at,updated_at) VALUES ($1,96312,'manager','active','Manager',2,clock_timestamp(),clock_timestamp())`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET active_org_id=$1 WHERE id=96312`, orgID); err != nil {
		t.Fatal(err)
	}
	if response := f.request(http.MethodPost, "/api/invitations", `{"email":"manager-target@example.invalid","role":"manager"}`, manager, ""); response.Code != http.StatusForbidden {
		t.Fatalf("manager invited manager: %d %s", response.Code, response.Body.String())
	}
	managerInvite := createInvitationProof(t, f, owner, "manager-target@example.invalid", "manager")
	if response := f.request(http.MethodDelete, "/api/invitations/"+managerInvite.UUID, "", manager, ""); response.Code != http.StatusForbidden {
		t.Fatalf("manager revoked manager invite: %d %s", response.Code, response.Body.String())
	}
	first := createInvitationProof(t, f, manager, "a96313@example.invalid", "member")
	second := createInvitationProof(t, f, manager, "a96314@example.invalid", "member")
	if _, err := f.fixture.Exec(f.ctx, `UPDATE organizations SET member_seat_limit_override=3 WHERE id=$1`, orgID); err != nil {
		t.Fatal(err)
	}
	configuration := f.runtime.Config()
	configuration.MaxConns = 4
	concurrent, err := pgxpool.NewWithConfig(f.ctx, configuration)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(concurrent.Close)
	parallel := f
	parallel.runtime = concurrent
	parallel.handler = app.Handler(concurrent)
	start := make(chan struct{})
	results := make(chan int, 2)
	var running sync.WaitGroup
	for _, test := range []struct {
		proof invitationCreatedProof
		token string
	}{{first, a}, {second, b}} {
		running.Add(1)
		go func() {
			defer running.Done()
			<-start
			response := parallel.request(http.MethodPost, "/api/invitations/"+test.proof.UUID+"/accept", invitationProofBody(test.proof), test.token, "")
			results <- response.Code
		}()
	}
	close(start)
	running.Wait()
	close(results)
	counts := map[int]int{}
	for status := range results {
		counts[status]++
	}
	if counts[http.StatusOK] != 1 || counts[http.StatusBadRequest] != 1 {
		t.Fatalf("one vacant seat results=%v", counts)
	}
	var members int
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM organization_members WHERE org_id=$1 AND NOT manual_disabled`, orgID).Scan(&members); err != nil || members != 3 {
		t.Fatalf("seat count=%d err=%v", members, err)
	}
	f.assertClean(t)
}
