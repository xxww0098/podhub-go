package integration

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"github.com/xxww0098/podhub-go/internal/identity"
)

func TestIdentitySessionIssuanceRechecksLockedCredential(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	service := identity.New(pool)
	for _, route := range []string{"login", "register"} {
		changes := []string{"password reset", "account disabled"}
		if route == "login" {
			changes = append(changes, "email changed")
		}
		for _, change := range changes {
			t.Run(route+"/"+change, func(t *testing.T) {
				user, email, _ := identitySessionFixture(t, ctx, pool)
				tx, err := pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(ctx)
				var blocker int
				if err := tx.QueryRow(ctx, `SELECT pg_backend_pid() FROM account_users WHERE id=$1 FOR UPDATE`, user).Scan(&blocker); err != nil {
					t.Fatal(err)
				}
				done := make(chan identity.Result, 1)
				go func() { done <- identitySessionRequest(ctx, service, route, email, "stale-request") }()
				waitIdentitySessionBlocked(t, ctx, pool, blocker)
				code := "AUTH_INVALID"
				switch change {
				case "password reset":
					if _, err := tx.Exec(ctx, `UPDATE account_users SET password_hash='replaced-after-verification' WHERE id=$1`, user); err != nil {
						t.Fatal(err)
					}
					if _, err := tx.Exec(ctx, `DELETE FROM account_sessions WHERE user_id=$1`, user); err != nil {
						t.Fatal(err)
					}
				case "account disabled":
					if _, err := tx.Exec(ctx, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=$1`, user); err != nil {
						t.Fatal(err)
					}
				case "email changed":
					if _, err := tx.Exec(ctx, `UPDATE account_users SET email=$2,session_revision=session_revision+1 WHERE id=$1`, user, "changed-"+email); err != nil {
						t.Fatal(err)
					}
				}
				if err := tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				select {
				case result := <-done:
					if result.Status != http.StatusUnauthorized || !strings.Contains(string(result.Body), `"code":"`+code+`"`) || len(result.Cookies) != 0 {
						t.Errorf("stale authentication issued a session: status=%d body=%s cookies=%d", result.Status, result.Body, len(result.Cookies))
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				assertIdentitySessionWrites(t, ctx, pool, user, 0)
			})
		}
	}
}

func TestIdentityRegistrationReplayReusesSession(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	service := identity.New(pool)
	user, email, hash := identitySessionFixture(t, ctx, pool)
	for _, route := range []string{"login", "register", "register"} {
		result := identitySessionRequest(ctx, service, route, email, "replayed-key")
		wantToken := identity.DeriveSessionToken(hash+"\x00"+"0", "replayed-key")
		if result.Status != http.StatusOK || !strings.Contains(string(result.Body), `"token":"`+wantToken+`"`) || len(result.Cookies) != 2 {
			t.Fatalf("%s rejected a valid credential replay: status=%d body=%s", route, result.Status, result.Body)
		}
	}
	var sessions int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM account_sessions WHERE user_id=$1`, user).Scan(&sessions); err != nil || sessions != 1 {
		t.Fatalf("valid replay should retain one session: count=%d err=%v", sessions, err)
	}
}

func identitySessionFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (int64, string, string) {
	t.Helper()
	email := "session-" + uuid.NewString() + "@example.com"
	hash, err := bcrypt.GenerateFromPassword([]byte("original-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	var user int64
	if err := pool.QueryRow(ctx, `INSERT INTO account_users (public_id,email,password_hash,name,created_at,updated_at) VALUES ($1,$2,$3,'Session authority',clock_timestamp(),clock_timestamp()) RETURNING id`, uuid.NewString(), email, string(hash)).Scan(&user); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE platform_initialization SET owner_account_id=$1,initialized_at=clock_timestamp() WHERE singleton`, user); err != nil {
		t.Fatal(err)
	}
	return user, email, string(hash)
}

func identitySessionRequest(ctx context.Context, service *identity.Service, route, email, key string) identity.Result {
	r := httptest.NewRequest(http.MethodPost, "/api/auth/"+route, strings.NewReader(`{"email":"`+email+`","password":"original-password"}`)).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Idempotency-Key", key)
	if route == "register" {
		return service.Register(r)
	}
	return service.Login(r)
}

func waitIdentitySessionBlocked(t *testing.T, ctx context.Context, pool *pgxpool.Pool, blocker int) {
	t.Helper()
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		var blocked bool
		err := pool.QueryRow(wait, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND (query LIKE '-- name: IssueSession%' OR query LIKE '-- name: TouchLastLogin%' OR query LIKE '-- name: AssertPassword%'))`, blocker).Scan(&blocked)
		if err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		select {
		case <-wait.Done():
			t.Fatal("authentication did not reach the locked session transaction")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func assertIdentitySessionWrites(t *testing.T, ctx context.Context, pool *pgxpool.Pool, user int64, want int) {
	t.Helper()
	var sessions, audits int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM account_sessions WHERE user_id=$1),(SELECT count(*) FROM audit_logs WHERE user_id=$1 AND action='session_issued')`, user).Scan(&sessions, &audits); err != nil || sessions != want || audits != want {
		t.Errorf("rejected login persisted session/audit: sessions=%d audits=%d want=%d err=%v", sessions, audits, want, err)
	}
}
