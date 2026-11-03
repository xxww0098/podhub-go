package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"github.com/xxww0098/podhub-go/internal/app"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

func TestIdentityProductionRole(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	t.Run("login session logout", func(t *testing.T) {
		bad := f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"wrong-password"}`, "", "")
		if bad.Code != http.StatusUnauthorized {
			t.Fatalf("bad password: %d %s", bad.Code, bad.Body.String())
		}
		var failures int
		if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM auth_login_attempts`).Scan(&failures); err != nil || failures != 2 {
			t.Fatalf("persisted failed attempts=%d err=%v", failures, err)
		}
		logged := f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"original-password"}`, "", "login-runtime")
		token := identityRuntimeToken(t, logged)
		response := f.request(http.MethodGet, "/api/auth/session", "", token, "")
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "a96311@example.invalid") || strings.Contains(response.Body.String(), "a96312@example.invalid") {
			t.Fatalf("session: %d %s", response.Code, response.Body.String())
		}
		admin := f.request(http.MethodGet, "/api/admin/platform-catalog", "", token, "")
		if admin.Code != http.StatusForbidden {
			t.Fatalf("regular user entered admin: %d %s", admin.Code, admin.Body.String())
		}
		loggedOut := f.request(http.MethodPost, "/api/auth/logout", "{}", token, "")
		if loggedOut.Code != http.StatusNoContent {
			t.Fatalf("logout: %d %s", loggedOut.Code, loggedOut.Body.String())
		}
		anonymous := f.request(http.MethodGet, "/api/auth/session", "", token, "")
		if anonymous.Code != http.StatusOK || !strings.Contains(anonymous.Body.String(), `"authenticated":false`) {
			t.Fatalf("revoked session: %d %s", anonymous.Code, anonymous.Body.String())
		}
		var sessions, audits int
		if err := f.fixture.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM account_sessions WHERE user_id=96311),(SELECT count(*) FROM audit_logs WHERE action IN ('session_issued','session_revoked'))`).Scan(&sessions, &audits); err != nil || sessions != 0 || audits != 2 {
			t.Fatalf("session state=%d audits=%d err=%v", sessions, audits, err)
		}
	})
	t.Run("register and replay", func(t *testing.T) {
		body := `{"email":"new-runtime@example.invalid","password":"new-account-password","name":"New runtime"}`
		created := f.request(http.MethodPost, "/api/auth/register", body, "", "register-runtime")
		token := identityRuntimeToken(t, created)
		replay := f.request(http.MethodPost, "/api/auth/register", body, "", "register-runtime")
		if again := identityRuntimeToken(t, replay); again != token {
			t.Fatalf("registration replay changed token")
		}
		session := f.request(http.MethodGet, "/api/auth/session", "", token, "")
		if session.Code != http.StatusOK || !strings.Contains(session.Body.String(), `"account_mode":"owner"`) || strings.Contains(session.Body.String(), `"email_verified"`) {
			t.Fatalf("registered session: %d %s", session.Code, session.Body.String())
		}
		var users, orgs, members, subscriptions, sessions, audits int
		if err := f.fixture.QueryRow(f.ctx, `WITH owner AS (SELECT id FROM account_users WHERE email='new-runtime@example.invalid')
			SELECT (SELECT count(*) FROM owner),
			 (SELECT count(*) FROM organizations WHERE owner_user_id IN (SELECT id FROM owner)),
			 (SELECT count(*) FROM organization_members WHERE user_id IN (SELECT id FROM owner) AND role='owner'),
			 (SELECT count(*) FROM subscriptions s JOIN organizations o ON o.id=s.org_id WHERE o.owner_user_id IN (SELECT id FROM owner) AND s.status='free'),
			 (SELECT count(*) FROM account_sessions WHERE user_id IN (SELECT id FROM owner)),
			 (SELECT count(*) FROM audit_logs WHERE user_id IN (SELECT id FROM owner) AND action='account_registered')`).Scan(&users, &orgs, &members, &subscriptions, &sessions, &audits); err != nil || users != 1 || orgs != 1 || members != 1 || subscriptions != 1 || sessions != 1 || audits != 1 {
			t.Fatalf("registration users=%d orgs=%d members=%d subscriptions=%d sessions=%d audits=%d err=%v", users, orgs, members, subscriptions, sessions, audits, err)
		}
	})
	f.assertClean(t)
}

func TestIdentityProductionRoleSharedPaths(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	token := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"original-password"}`, "", "shared-paths"))
	for _, path := range []string{"/api/auth/verify", "/api/auth/verify/resend"} {
		if response := f.request(http.MethodPost, path, "{}", token, ""); response.Code != http.StatusNotFound {
			t.Fatalf("removed email verification route %s: %d %s", path, response.Code, response.Body.String())
		}
	}
	if response := f.request(http.MethodPut, "/api/auth/name", `{"name":"Runtime Renamed"}`, token, ""); response.Code != http.StatusOK {
		t.Fatalf("rename: %d %s", response.Code, response.Body.String())
	}
	var accountName, profileName, memberName string
	if err := f.fixture.QueryRow(f.ctx, `SELECT u.name,p.name,m.display_name FROM account_users u JOIN account_profiles p ON p.user_id=u.id JOIN organization_members m ON m.user_id=u.id WHERE u.id=96311`).Scan(&accountName, &profileName, &memberName); err != nil || accountName != "Runtime Renamed" || profileName != accountName || memberName != accountName {
		t.Fatalf("profile names=%q/%q/%q err=%v", accountName, profileName, memberName, err)
	}
	changed := f.request(http.MethodPost, "/api/auth/password", `{"current_password":"original-password","new_password":"changed-password"}`, token, "change-runtime")
	newToken := identityRuntimeToken(t, changed)
	f.requireAnonymous(t, token)
	for _, email := range []string{"missing@example.invalid", "a96311@example.invalid", "a96311@example.invalid"} {
		if response := f.request(http.MethodPost, "/api/auth/forgot", fmt.Sprintf(`{"email":%q}`, email), "", ""); response.Code != http.StatusServiceUnavailable {
			t.Fatalf("forgot: %d %s", response.Code, response.Body.String())
		}
	}
	var issued int
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM auth_email_tokens WHERE user_id=96311 AND purpose='reset'`).Scan(&issued); err != nil || issued != 0 {
		t.Fatalf("reset tokens=%d err=%v", issued, err)
	}
	resetToken := strings.Repeat("A", 43)
	f.emailToken(t, resetToken, "reset")
	resetBody := `{"token":"` + resetToken + `","password":"reset-password"}`
	if response := f.request(http.MethodPost, "/api/auth/reset", resetBody, "", ""); response.Code != http.StatusOK {
		t.Fatalf("reset password: %d %s", response.Code, response.Body.String())
	}
	f.requireAnonymous(t, newToken)
	if response := f.request(http.MethodPost, "/api/auth/reset", resetBody, "", ""); response.Code != http.StatusBadRequest {
		t.Fatalf("reset replay: %d %s", response.Code, response.Body.String())
	}
	token = identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"reset-password"}`, "", "after-reset"))
	// One browser holds one account: a stale `sids` cookie from the retired
	// stack must not authenticate anyone, and login must not hand one out.
	otherToken := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96312@example.invalid","password":"original-password"}`, "", "other-account"))
	retired := f.cookieRequest(http.MethodGet, "/api/auth/session", "", "sids="+otherToken)
	if retired.Code != http.StatusOK || strings.Contains(retired.Body.String(), `"authenticated":true`) {
		t.Fatalf("retired stack cookie authenticated: %d %s", retired.Code, retired.Body.String())
	}
	login := f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"reset-password"}`, "", "single-cookie")
	for _, cookie := range login.Result().Cookies() {
		if cookie.Name == "sids" && cookie.Value != "" {
			t.Fatalf("login re-issued the retired stack cookie: %s", cookie.Value)
		}
	}
	if switched := f.cookieRequest(http.MethodPost, "/api/auth/switch", `{"uuid":"any"}`, "sid="+token); switched.Code != http.StatusNotFound {
		t.Fatalf("retired account switch route answered %d %s", switched.Code, switched.Body.String())
	}
	f.assertClean(t)
}

func TestIdentityProductionRoleRefusalsAndRollback(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	loginBody := `{"email":"a96311@example.invalid","password":"original-password"}`
	if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=96311`); err != nil {
		t.Fatal(err)
	}
	if response := f.request(http.MethodPost, "/api/auth/login", loginBody, "", "disabled"); response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), "账号已禁用") {
		t.Fatalf("disabled login: %d %s", response.Code, response.Body.String())
	}
	if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET disabled_at=NULL WHERE id=96311`); err != nil {
		t.Fatal(err)
	}
	if response := f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"wrong-password"}`, "", "wrong-password"); response.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password login: %d %s", response.Code, response.Body.String())
	}
	// A failure after the session or registration writes must roll everything
	// back, including the new workspace's RLS-protected free subscription.
	if _, err := f.fixture.Exec(f.ctx, `ALTER TABLE audit_logs ADD CONSTRAINT identity_runtime_reject_audit CHECK (action NOT IN ('session_issued','account_registered'))`); err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"login", "register"} {
		body := loginBody
		if route == "register" {
			body = `{"email":"rollback-runtime@example.invalid","password":"original-password"}`
		}
		if response := f.request(http.MethodPost, "/api/auth/"+route, body, "", "rollback-"+route); response.Code != http.StatusInternalServerError {
			t.Fatalf("failed audit %s: %d %s", route, response.Code, response.Body.String())
		}
	}
	var users, sessions, orgs, subscriptions int
	if err := f.fixture.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM account_users),(SELECT count(*) FROM account_sessions),(SELECT count(*) FROM organizations),(SELECT count(*) FROM subscriptions)`).Scan(&users, &sessions, &orgs, &subscriptions); err != nil || users != 2 || sessions != 0 || orgs != 2 || subscriptions != 0 {
		t.Fatalf("failed identity writes persisted users=%d sessions=%d orgs=%d subscriptions=%d err=%v", users, sessions, orgs, subscriptions, err)
	}
	if _, err := f.fixture.Exec(f.ctx, `ALTER TABLE audit_logs DROP CONSTRAINT identity_runtime_reject_audit`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 7; i++ {
		response := f.request(http.MethodPost, "/api/auth/login", `{"email":"unknown@example.invalid","password":"wrong-password"}`, "", "")
		want := http.StatusUnauthorized
		if i == 6 {
			want = http.StatusTooManyRequests
		}
		if response.Code != want {
			t.Fatalf("throttle attempt %d: %d %s", i, response.Code, response.Body.String())
		}
	}
	f.assertClean(t)
}

type identityRuntimeFixture struct {
	ctx     context.Context
	fixture *pgxpool.Pool
	runtime *pgxpool.Pool
	handler http.Handler
}

func newIdentityRuntimeFixture(t *testing.T) identityRuntimeFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	t.Cleanup(cancel)
	t.Setenv("PODHUB_PARITY_DSN", "")
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	dsn := securityDSN(t, ctx)
	fixture, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(fixture.Close)
	if err := db.Migrate(ctx, fixture); err != nil {
		t.Fatal(err)
	}
	for _, user := range []int64{96311, 96312} {
		seedAITenant(t, ctx, fixture, user)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte("original-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.Exec(ctx, `UPDATE account_users SET password_hash=$1,public_id=gen_random_uuid()::text WHERE id IN (96311,96312)`, string(hash)); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.Exec(ctx, `UPDATE platform_initialization SET owner_account_id=96311,initialized_at=clock_timestamp() WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'identity-runtime-test'`); err != nil {
		t.Fatal(err)
	}
	apiURL, err := url.Parse(swapUser(dsn, "podhub_login_api", "identity-runtime-test"))
	if err != nil {
		t.Fatal(err)
	}
	query := apiURL.Query()
	query.Set("pool_max_conns", "1")
	apiURL.RawQuery = query.Encode()
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	runtime, err := db.Connect(ctx, config.Config{DatabaseURL: apiURL.String()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtime.Close)
	f := identityRuntimeFixture{ctx: ctx, fixture: fixture, runtime: runtime, handler: app.Handler(runtime)}
	f.assertClean(t)
	return f
}

func (f identityRuntimeFixture) request(method, path, body, token, key string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(f.ctx)
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	return response
}

func (f identityRuntimeFixture) cookieRequest(method, path, body, cookie string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(f.ctx)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Cookie", cookie)
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	return response
}

func (f identityRuntimeFixture) emailToken(t *testing.T, token, purpose string) {
	t.Helper()
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO auth_email_tokens(token_hash,user_id,purpose,expires_at,created_at) VALUES($1,96311,$2,clock_timestamp()+interval '1 hour',clock_timestamp())`, sha256Hex(token), purpose); err != nil {
		t.Fatal(err)
	}
}

func (f identityRuntimeFixture) requireAnonymous(t *testing.T, token string) {
	t.Helper()
	response := f.request(http.MethodGet, "/api/auth/session", "", token, "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"authenticated":false`) {
		t.Fatalf("revoked session: %d %s", response.Code, response.Body.String())
	}
}

func (f identityRuntimeFixture) assertClean(t *testing.T) {
	t.Helper()
	assertCatalogLogin(t, f.ctx, f.runtime)
	var org, staff string
	if err := f.runtime.QueryRow(f.ctx, `SELECT COALESCE(current_setting('app.current_org_id',true),''),COALESCE(current_setting('app.staff_access',true),'')`).Scan(&org, &staff); err != nil || org != "" || staff != "" {
		t.Fatalf("leaked identity settings org=%q staff=%q err=%v", org, staff, err)
	}
	if got := f.runtime.Stat().AcquiredConns(); got != 0 {
		t.Fatalf("identity retained %d connections", got)
	}
}

func identityRuntimeToken(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	var result struct {
		Data struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Data.Token == "" {
		t.Fatal(fmt.Sprintf("authentication: %d %s", response.Code, response.Body.String()))
	}
	return result.Data.Token
}
