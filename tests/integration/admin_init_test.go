package integration

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"github.com/xxww0098/podhub-go/internal/app"
	"github.com/xxww0098/podhub-go/internal/identity"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

func TestAdminInitialization(t *testing.T) {
	ctx, fixture, runtime := adminInitPools(t)
	service := identity.New(runtime)
	if ready, err := service.AdminInitialized(ctx); err != nil || ready {
		t.Fatalf("fresh database ready=%v err=%v", ready, err)
	}
	for _, input := range []struct{ email, password string }{
		{"invalid", "correct-horse"},
		{strings.Repeat("a", 305) + "@example.invalid", "correct-horse"},
		{"owner@example.invalid", "short"},
		{"owner@example.invalid", strings.Repeat("x", 73)},
	} {
		if err := service.InitializeAdmin(ctx, input.email, input.password); err == nil {
			t.Fatalf("invalid credentials accepted: email=%q password bytes=%d", input.email, len(input.password))
		}
	}
	assertAdminInitEmpty(t, ctx, fixture)
	if err := service.InitializeAdmin(ctx, "owner@example.invalid", "correct-horse"); err != nil {
		t.Fatal(err)
	}
	if ready, err := service.AdminInitialized(ctx); err != nil || !ready {
		t.Fatalf("initialized database ready=%v err=%v", ready, err)
	}
	var role, hash, credentialHash, profileName string
	var initialized, hasWorkspace bool
	var admins, audits, orgs int
	if err := fixture.QueryRow(ctx, `
SELECT u.role,u.password_hash,c.password_hash,p.name,
       i.owner_account_id=u.id AND i.initialized_at IS NOT NULL,
       p.active_org_id IS NOT NULL,
       (SELECT count(*) FROM account_users WHERE role='super_admin'),
       (SELECT count(*) FROM audit_logs WHERE action='platform_initialized' AND user_id=u.id),
       (SELECT count(*) FROM organizations WHERE owner_user_id=u.id)
FROM account_users u
JOIN account_credentials c ON c.user_id=u.id
JOIN account_profiles p ON p.user_id=u.id
CROSS JOIN platform_initialization i
WHERE u.email='owner@example.invalid' AND i.singleton`).Scan(&role, &hash, &credentialHash, &profileName, &initialized, &hasWorkspace, &admins, &audits, &orgs); err != nil {
		t.Fatal(err)
	}
	if role != "super_admin" || hash != credentialHash || profileName == "" || !initialized || hasWorkspace || admins != 1 || audits != 1 || orgs != 0 {
		t.Fatalf("role=%q credentials=%v profile=%q initialized=%v workspace=%v admins=%d audits=%d orgs=%d", role, hash == credentialHash, profileName, initialized, hasWorkspace, admins, audits, orgs)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte("correct-horse")); err != nil {
		t.Fatalf("stored password does not authenticate: %v", err)
	}
	for _, email := range []string{"owner@example.invalid", "replacement@example.invalid"} {
		if err := service.InitializeAdmin(ctx, email, "replacement-password"); !errors.Is(err, identity.ErrAdminInitialized) {
			t.Fatalf("repeat initialization: %v", err)
		}
	}
	var after string
	var users int
	if err := fixture.QueryRow(ctx, `SELECT password_hash,(SELECT count(*) FROM account_users) FROM account_users WHERE email='owner@example.invalid'`).Scan(&after, &users); err != nil || after != hash || users != 1 {
		t.Fatalf("repeat changed credentials=%v users=%d err=%v", after != hash, users, err)
	}
	logged := postJSON(t, app.Handler(runtime), "/api/auth/login", `{"email":"owner@example.invalid","password":"correct-horse"}`, "", "")
	if logged.Code != http.StatusOK || !strings.Contains(logged.Body.String(), `"role":"super_admin"`) {
		t.Fatalf("initialized admin login: %d %s", logged.Code, logged.Body.String())
	}
	overview := get(t, app.Handler(runtime), "/api/view/account-overview", logged.Header().Get("Set-Cookie"))
	if overview.Code != http.StatusOK || !strings.Contains(overview.Body.String(), `"owned_count":0`) {
		t.Fatalf("initialized admin overview: %d %s", overview.Code, overview.Body.String())
	}
	assertCatalogLogin(t, ctx, runtime)
}

func TestAdminInitializationLongEmail(t *testing.T) {
	ctx, fixture, runtime := adminInitPools(t)
	email := strings.Repeat("a", 300) + "@example.invalid"
	if err := identity.New(runtime).InitializeAdmin(ctx, email, "correct-horse"); err != nil {
		t.Fatalf("email within the 320-character limit: %v", err)
	}
	var name string
	if err := fixture.QueryRow(ctx, `SELECT name FROM account_users WHERE email=$1`, email).Scan(&name); err != nil || name == "" {
		t.Fatalf("long-email admin profile name=%q err=%v", name, err)
	}
}

func TestAdminInitializationRefusesExistingAccounts(t *testing.T) {
	for _, role := range []string{"user", "super_admin"} {
		t.Run(role, func(t *testing.T) {
			ctx, fixture, runtime := adminInitPools(t)
			if _, err := fixture.Exec(ctx, `INSERT INTO account_users(public_id,email,password_hash,role,name,created_at,updated_at)
VALUES(gen_random_uuid()::text,'existing@example.invalid','original-hash',$1,'Existing',clock_timestamp(),clock_timestamp())`, role); err != nil {
				t.Fatal(err)
			}
			service := identity.New(runtime)
			email := "existing@example.invalid"
			if role == "super_admin" {
				email = "replacement@example.invalid"
			}
			err := service.InitializeAdmin(ctx, email, "correct-horse")
			if err == nil || (role == "super_admin" && !errors.Is(err, identity.ErrAdminInitialized)) {
				t.Fatalf("existing %s: %v", role, err)
			}
			var storedRole, hash string
			var users int
			var marked bool
			if err := fixture.QueryRow(ctx, `SELECT role,password_hash,(SELECT count(*) FROM account_users),
    (SELECT owner_account_id IS NOT NULL FROM platform_initialization WHERE singleton)
FROM account_users WHERE email='existing@example.invalid'`).Scan(&storedRole, &hash, &users, &marked); err != nil || storedRole != role || hash != "original-hash" || users != 1 || marked {
				t.Fatalf("existing account changed: role=%q hashChanged=%v users=%d marked=%v err=%v", storedRole, hash != "original-hash", users, marked, err)
			}
			if ready, err := service.AdminInitialized(ctx); err != nil || ready != (role == "super_admin") {
				t.Fatalf("existing %s ready=%v err=%v", role, ready, err)
			}
			assertCatalogLogin(t, ctx, runtime)
		})
	}
}

func TestAdminInitializationConcurrent(t *testing.T) {
	ctx, fixture, runtime := adminInitPools(t)
	service := identity.New(runtime)
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, email := range []string{"first@example.invalid", "second@example.invalid"} {
		go func() {
			<-start
			results <- service.InitializeAdmin(ctx, email, "correct-horse")
		}()
	}
	close(start)
	succeeded, refused := 0, 0
	for range 2 {
		err := <-results
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, identity.ErrAdminInitialized):
			refused++
		default:
			t.Errorf("concurrent initialization: %v", err)
		}
	}
	var users, marked, audits int
	if err := fixture.QueryRow(ctx, `SELECT (SELECT count(*) FROM account_users),
    (SELECT count(*) FROM platform_initialization i JOIN account_users u ON u.id=i.owner_account_id WHERE u.role='super_admin' AND i.initialized_at IS NOT NULL),
    (SELECT count(*) FROM audit_logs WHERE action='platform_initialized')`).Scan(&users, &marked, &audits); err != nil || succeeded != 1 || refused != 1 || users != 1 || marked != 1 || audits != 1 {
		t.Fatalf("success=%d refused=%d users=%d marked=%d audits=%d err=%v", succeeded, refused, users, marked, audits, err)
	}
	assertCatalogLogin(t, ctx, runtime)
}

func TestAdminInitializationRollsBackAuditFailure(t *testing.T) {
	ctx, fixture, runtime := adminInitPools(t)
	if _, err := fixture.Exec(ctx, `ALTER TABLE audit_logs ADD CONSTRAINT admin_init_reject_audit CHECK (action <> 'platform_initialized')`); err != nil {
		t.Fatal(err)
	}
	service := identity.New(runtime)
	if err := service.InitializeAdmin(ctx, "owner@example.invalid", "correct-horse"); err == nil {
		t.Fatal("initialization succeeded without its audit")
	}
	assertAdminInitEmpty(t, ctx, fixture)
	if _, err := fixture.Exec(ctx, `ALTER TABLE audit_logs DROP CONSTRAINT admin_init_reject_audit`); err != nil {
		t.Fatal(err)
	}
	if err := service.InitializeAdmin(ctx, "owner@example.invalid", "correct-horse"); err != nil {
		t.Fatalf("retry after rollback: %v", err)
	}
	assertCatalogLogin(t, ctx, runtime)
}

func adminInitPools(t *testing.T) (context.Context, *pgxpool.Pool, *pgxpool.Pool) {
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
	if _, err := fixture.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'admin-init-test'`); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	runtime, err := db.Connect(ctx, config.Config{DatabaseURL: swapUser(dsn, "podhub_login_api", "admin-init-test")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtime.Close)
	assertCatalogLogin(t, ctx, runtime)
	return ctx, fixture, runtime
}

func assertAdminInitEmpty(t *testing.T, ctx context.Context, fixture *pgxpool.Pool) {
	t.Helper()
	var users, credentials, profiles, audits int
	var marked bool
	if err := fixture.QueryRow(ctx, `SELECT (SELECT count(*) FROM account_users),
    (SELECT count(*) FROM account_credentials),(SELECT count(*) FROM account_profiles),
    (SELECT count(*) FROM audit_logs WHERE action='platform_initialized'),
    (SELECT owner_account_id IS NOT NULL OR initialized_at IS NOT NULL FROM platform_initialization WHERE singleton)`).Scan(&users, &credentials, &profiles, &audits, &marked); err != nil || users != 0 || credentials != 0 || profiles != 0 || audits != 0 || marked {
		t.Fatalf("partial initialization: users=%d credentials=%d profiles=%d audits=%d marked=%v err=%v", users, credentials, profiles, audits, marked, err)
	}
}
