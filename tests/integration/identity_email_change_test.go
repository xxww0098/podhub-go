package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/identity"
)

type changeMailer struct {
	recoveryMailer
	changes []recoveryMessage
	failure error
}

func (m *changeMailer) SendEmailChange(_ context.Context, email, token string) error {
	m.changes = append(m.changes, recoveryMessage{email: email, token: token})
	return m.failure
}

func requestEmailChange(f identityRuntimeFixture, svc *identity.Service, session, email, password string) identity.Result {
	body, _ := json.Marshal(map[string]string{"email": email, "current_password": password})
	r := httptest.NewRequest(http.MethodPost, "/api/auth/email/change", bytes.NewReader(body)).WithContext(f.ctx)
	r.Header.Set("Authorization", "Bearer "+session)
	return svc.RequestEmailChange(r)
}

func confirmEmailChange(f identityRuntimeFixture, token string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"token": token})
	return f.request(http.MethodPost, "/api/auth/email/confirm", string(body), "", "")
}

func TestIdentityEmailChangeEndToEnd(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	mailer := &changeMailer{}
	svc := identity.New(f.runtime).WithPasswordRecovery(mailer, bytes.Repeat([]byte{23}, 32))
	owner := invitationLogin(t, f, 96311)
	oldSession := invitationLogin(t, f, 96312)
	oldInvite := createWorkspaceInvitation(t, f, owner, "a96312@example.invalid", "member")
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO org_invitations (org_id,email,role,invited_by_user_id,invited_by_email,invitee_user_id,expires_at,created_at,updated_at)
	 SELECT org_id,'new-address@example.invalid','member',96311,'a96311@example.invalid',96311,clock_timestamp()-interval '1 day',clock_timestamp(),clock_timestamp()
	 FROM organization_members WHERE user_id=96311 AND role='owner'`); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		email, password string
		status          int
	}{
		{"not-an-email", "original-password", http.StatusBadRequest},
		{"new\x00@example.invalid", "original-password", http.StatusBadRequest},
		{"A96312@example.invalid", "original-password", http.StatusBadRequest},
		{"new-address@example.invalid", "incorrect", http.StatusBadRequest},
		{"a96311@example.invalid", "original-password", http.StatusConflict},
	} {
		if got := requestEmailChange(f, svc, oldSession, tc.email, tc.password); got.Status != tc.status {
			t.Fatalf("request %q: %d %s", tc.email, got.Status, got.Body)
		}
	}
	requireRecoveryAccepted(t, recoveryForgot(f.ctx, svc, "a96312@example.invalid", "198.51.100.11"))
	if got := requestEmailChange(f, svc, oldSession, "new-address@example.invalid", "original-password"); got.Status != http.StatusOK {
		t.Fatalf("request: %d %s", got.Status, got.Body)
	}
	if got := requestEmailChange(f, svc, oldSession, "another@example.invalid", "original-password"); got.Status != http.StatusTooManyRequests {
		t.Fatalf("cooldown: %d %s", got.Status, got.Body)
	}
	var before string
	if err := f.fixture.QueryRow(f.ctx, `SELECT email FROM account_users WHERE id=96312`).Scan(&before); err != nil || before != "a96312@example.invalid" {
		t.Fatalf("unconfirmed email changed: %q %v", before, err)
	}
	if n, err := svc.DeliverPasswordResets(f.ctx, 4); err != nil || n != 2 {
		t.Fatalf("deliver recovery and confirmation: %d %v", n, err)
	}
	if len(mailer.changes) != 1 || mailer.changes[0].email != "new-address@example.invalid" || len(mailer.sent()) != 1 {
		t.Fatalf("wrong mail destinations: changes=%v recovery=%v", mailer.changes, mailer.sent())
	}
	token := mailer.changes[0].token
	if !identity.IsSessionToken(token) {
		t.Fatal("confirmation token is malformed")
	}
	if res := confirmEmailChange(f, token); res.Code != http.StatusOK {
		t.Fatalf("confirm: %d %s", res.Code, res.Body.String())
	}
	if res := confirmEmailChange(f, token); res.Code != http.StatusBadRequest {
		t.Fatalf("replayed confirmation: %d %s", res.Code, res.Body.String())
	}
	if res := recoveryReset(f.ctx, svc, mailer.sent()[0].token, "recovered-password"); res.Status != http.StatusBadRequest {
		t.Fatalf("old recovery link: %d %s", res.Status, res.Body)
	}
	f.requireAnonymous(t, oldSession)
	if res := f.request(http.MethodPost, "/api/auth/login", `{"email":"a96312@example.invalid","password":"original-password"}`, "", "invitation-96312"); res.Code != http.StatusUnauthorized {
		t.Fatalf("old email login: %d %s", res.Code, res.Body.String())
	}
	newSession := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"NEW-ADDRESS@example.invalid","password":"original-password"}`, "", "invitation-96312"))
	if newSession == oldSession {
		t.Fatal("reused idempotency key revived a revoked session")
	}
	f.requireAnonymous(t, oldSession)
	var recipient int64
	var email string
	var notifications int
	var expiredRevoked bool
	err := f.fixture.QueryRow(f.ctx, `SELECT i.invitee_user_id,i.email,
	 (SELECT count(*) FROM notifications n WHERE n.invitation_id=i.id AND n.user_id=96312),
	 (SELECT revoked_at IS NOT NULL FROM org_invitations WHERE email='new-address@example.invalid' AND expires_at<=clock_timestamp())
	 FROM org_invitations i WHERE i.uuid=$1::uuid`, oldInvite.UUID).Scan(&recipient, &email, &notifications, &expiredRevoked)
	if err != nil || recipient != 96312 || email != "new-address@example.invalid" || notifications != 1 || !expiredRevoked {
		t.Fatalf("invitation after email change: recipient=%d email=%q notifications=%d expired revoked=%v err=%v", recipient, email, notifications, expiredRevoked, err)
	}
	newOwner := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/register", `{"email":"a96312@example.invalid","password":"replacement-password"}`, "", "old-email-register"))
	if res := f.request(http.MethodPost, "/api/invitations/"+oldInvite.UUID+"/accept", "", newOwner, ""); res.Code != http.StatusBadRequest {
		t.Fatalf("old email account accepted invitation: %d %s", res.Code, res.Body.String())
	}
	if res := f.request(http.MethodPost, "/api/invitations/"+oldInvite.UUID+"/accept", "", newSession, ""); res.Code != http.StatusOK {
		t.Fatalf("recipient accepted after email change: %d %s", res.Code, res.Body.String())
	}
	f.assertClean(t)
}

func TestIdentityEmailChangeInvalidationAndConflict(t *testing.T) {
	for _, tc := range []string{"password", "disabled", "expired", "delivery rejected", "email taken"} {
		t.Run(tc, func(t *testing.T) {
			f := newIdentityRuntimeFixture(t)
			mailer := &changeMailer{}
			if tc == "delivery rejected" {
				mailer.failure = identity.ErrResetMailRejected
			}
			svc := identity.New(f.runtime).WithPasswordRecovery(mailer, bytes.Repeat([]byte{23}, 32))
			session := invitationLogin(t, f, 96312)
			if got := requestEmailChange(f, svc, session, "pending@example.invalid", "original-password"); got.Status != http.StatusOK {
				t.Fatalf("request: %d %s", got.Status, got.Body)
			}
			if n, err := svc.DeliverPasswordResets(f.ctx, 1); err != nil || n != 1 || len(mailer.changes) != 1 {
				t.Fatalf("delivery: %d %v", n, err)
			}
			token := mailer.changes[0].token
			switch tc {
			case "password":
				res := f.request(http.MethodPost, "/api/auth/password", `{"current_password":"original-password","new_password":"new-password"}`, session, "")
				if res.Code != http.StatusOK {
					t.Fatalf("password: %d %s", res.Code, res.Body.String())
				}
			case "disabled":
				if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=96312`); err != nil {
					t.Fatal(err)
				}
			case "expired":
				if _, err := f.fixture.Exec(f.ctx, `UPDATE auth_email_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1`, sha256Hex(token)); err != nil {
					t.Fatal(err)
				}
			case "email taken":
				if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET email='pending@example.invalid' WHERE id=96311`); err != nil {
					t.Fatal(err)
				}
			}
			want := http.StatusBadRequest
			if tc == "email taken" {
				want = http.StatusConflict
			}
			if res := confirmEmailChange(f, token); res.Code != want {
				t.Fatalf("%s confirmation: %d %s", tc, res.Code, res.Body.String())
			}
			var email string
			if err := f.fixture.QueryRow(f.ctx, `SELECT email FROM account_users WHERE id=96312`).Scan(&email); err != nil || email != "a96312@example.invalid" {
				t.Fatalf("failed confirmation changed address: %q %v", email, err)
			}
			if tc == "email taken" {
				res := f.request(http.MethodGet, "/api/auth/session", "", session, "")
				if !strings.Contains(res.Body.String(), `"authenticated":true`) {
					t.Fatalf("conflict revoked session: %s", res.Body.String())
				}
			}
			f.assertClean(t)
		})
	}
}

func TestIdentityEmailChangeForSupplierAndSupersededLinks(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO account_users(public_id,email,password_hash,name,target,account_kind,created_at,updated_at)
	 SELECT gen_random_uuid()::text,'factory@example.invalid',password_hash,'Factory','/supplier','supplier',clock_timestamp(),clock_timestamp()
	 FROM account_users WHERE id=96312`); err != nil {
		t.Fatal(err)
	}
	mailer := &changeMailer{}
	svc := identity.New(f.runtime).WithPasswordRecovery(mailer, bytes.Repeat([]byte{23}, 32))
	session := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"factory@example.invalid","password":"original-password"}`, "", "factory-email"))
	if got := requestEmailChange(f, svc, session, "first@example.invalid", "original-password"); got.Status != http.StatusOK {
		t.Fatalf("first request: %d %s", got.Status, got.Body)
	}
	if n, err := svc.DeliverPasswordResets(f.ctx, 1); err != nil || n != 1 {
		t.Fatalf("first delivery: %d %v", n, err)
	}
	first := mailer.changes[0].token
	if _, err := f.fixture.Exec(f.ctx, `UPDATE auth_email_tokens SET created_at=clock_timestamp()-interval '61 seconds' WHERE token_hash=$1`, sha256Hex(first)); err != nil {
		t.Fatal(err)
	}
	if got := requestEmailChange(f, svc, session, "second@example.invalid", "original-password"); got.Status != http.StatusOK {
		t.Fatalf("replacement request: %d %s", got.Status, got.Body)
	}
	if n, err := svc.DeliverPasswordResets(f.ctx, 1); err != nil || n != 1 {
		t.Fatalf("second delivery: %d %v", n, err)
	}
	if res := confirmEmailChange(f, first); res.Code != http.StatusBadRequest {
		t.Fatalf("superseded link: %d %s", res.Code, res.Body.String())
	}
	if res := confirmEmailChange(f, mailer.changes[1].token); res.Code != http.StatusOK {
		t.Fatalf("supplier confirmation: %d %s", res.Code, res.Body.String())
	}
	f.requireAnonymous(t, session)
	identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"second@example.invalid","password":"original-password"}`, "", "factory-email"))
	f.assertClean(t)
}

func TestInvitationEmailLockPrecedesUserLock(t *testing.T) {
	f := recoveryConcurrentFixture(t)
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	session := invitationLogin(t, f, 96312)
	holder, err := f.fixture.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(f.ctx)
	var pid int
	if err := holder.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := holder.Exec(f.ctx, `SELECT pg_advisory_xact_lock(hashtextextended('workspace-invitation-email:' || lower($1), 0))`, "a96311@example.invalid"); err != nil {
		t.Fatal(err)
	}
	svc := identity.New(f.runtime)
	done := make(chan identity.Result, 1)
	go func() {
		r := httptest.NewRequest(http.MethodPost, "/api/invitations", strings.NewReader(`{"email":"a96311@example.invalid","role":"member"}`)).WithContext(f.ctx)
		r.Header.Set("Authorization", "Bearer "+session)
		done <- svc.CreateInvitation(r)
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var blocked bool
		if err := f.fixture.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("invitation did not reach the email lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	probe, err := f.fixture.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	var userID int64
	err = probe.QueryRow(f.ctx, `SELECT id FROM account_users WHERE id=96312 FOR UPDATE NOWAIT`).Scan(&userID)
	_ = probe.Rollback(f.ctx)
	if err != nil || userID != 96312 {
		t.Fatalf("email wait held the user lock: %d %v", userID, err)
	}
	if err := holder.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-done:
		if result.Status != http.StatusOK {
			t.Fatalf("invitation: %d %s", result.Status, result.Body)
		}
	case <-f.ctx.Done():
		t.Fatal(f.ctx.Err())
	}
}

func TestIdentityEmailChangePasswordThrottling(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	mailer := &changeMailer{}
	svc := identity.New(f.runtime).WithPasswordRecovery(mailer, bytes.Repeat([]byte{23}, 32))
	session := invitationLogin(t, f, 96312)
	for attempt := 1; attempt <= 7; attempt++ {
		r := httptest.NewRequest(http.MethodPost, "/api/auth/email/change", strings.NewReader(`{"email":"new@example.invalid","current_password":"wrong-password"}`)).WithContext(f.ctx)
		r.RemoteAddr = "198.51.100.20:1234"
		r.Header.Set("Authorization", "Bearer "+session)
		r.Header.Set("X-Forwarded-For", "203.0.113."+strconv.Itoa(attempt))
		got := svc.RequestEmailChange(r)
		want := http.StatusBadRequest
		if attempt == 7 {
			want = http.StatusTooManyRequests
		}
		if got.Status != want {
			t.Fatalf("attempt %d: %d %s", attempt, got.Status, got.Body)
		}
	}
}
