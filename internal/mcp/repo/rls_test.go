package mcprepo

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/xxww0098/podhub-go/internal/mcp/domain"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

var (
	parityOnce sync.Once
	parityPool *pgxpool.Pool
	parityErr  error
)

func parityDB(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("PODHUB_PARITY_DSN")
	if dsn == "" {
		if _, err := os.Stat("/var/run/docker.sock"); err != nil {
			t.Skip("docker daemon is not available")
		}
	}
	parityOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if dsn == "" {
			container, err := postgres.Run(ctx, "postgres:16-alpine",
				postgres.WithDatabase("podhub"),
				postgres.WithUsername("postgres"),
				postgres.WithPassword("postgres"),
				postgres.BasicWaitStrategies(),
			)
			if err != nil {
				parityErr = err
				return
			}
			dsn, err = container.ConnectionString(ctx, "sslmode=disable")
			if err != nil {
				parityErr = err
				return
			}
		}
		cfg := config.Config{DatabaseURL: dsn}
		if err := cfg.CheckDatabase(); err != nil {
			parityErr = err
			return
		}
		_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
		pool, err := db.Connect(ctx, cfg)
		if err != nil {
			parityErr = err
			return
		}
		if err := db.Migrate(ctx, pool); err != nil {
			pool.Close()
			parityErr = err
			return
		}
		parityPool = pool
	})
	if parityErr != nil {
		t.Fatal(parityErr)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	return parityPool, ctx
}

func seedGrant(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tag string) (domain.Grant, string) {
	t.Helper()
	stamp := tag + "-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	var user, org int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO public.account_users (public_id, email, password_hash, name, created_at, updated_at)
		VALUES ($1, $1, 'x', $1, clock_timestamp(), clock_timestamp())
		RETURNING id`, stamp+"@example.com").Scan(&user); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO public.organizations (owner_user_id, name, created_at, updated_at)
		VALUES ($1, $2, clock_timestamp(), clock_timestamp())
		RETURNING id`, user, "ws "+stamp).Scan(&org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, join_order, created_at, updated_at)
		VALUES ($1, $2, 'owner', 'active', 'MCP', 1, clock_timestamp(), clock_timestamp())`, org, user); err != nil {
		t.Fatal(err)
	}
	token := "opa_rls_" + stamp
	grantID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO automation_grants (id, user_id, org_id, name, token_hash, token_prefix, actions)
		VALUES ($1::uuid, $2, $3, $4, $5, 'opa_rl', ARRAY['read']::text[])`,
		grantID, user, org, stamp, domain.HashToken(token)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `DELETE FROM automation_executions WHERE grant_id = $1::uuid`, grantID)
		_, _ = pool.Exec(c, `DELETE FROM automation_grants WHERE id = $1::uuid`, grantID)
	})
	r := New(pool)
	grant, err := r.Resolve(ctx, domain.HashToken(token))
	if err != nil || grant == nil {
		t.Fatalf("resolve %s: %v %v", tag, grant, err)
	}
	return *grant, "ws " + stamp
}

func hostCode(err error) string {
	var h *domain.HostError
	if errors.As(err, &h) {
		return h.Code
	}
	return ""
}

func TestGrantSessionIsolatesExecutions(t *testing.T) {
	pool, ctx := parityDB(t)
	r := New(pool)
	grantA, nameA := seedGrant(t, ctx, pool, "mcp-a")
	grantB, _ := seedGrant(t, ctx, pool, "mcp-b")
	version, err := domain.Version(grantA)
	if err != nil {
		t.Fatal(err)
	}
	digestA := strings.Repeat("a", 64)
	digestOther := strings.Repeat("b", 64)
	execID := uuid.NewString()
	start, err := r.Begin(ctx, grantA, execID, digestA, version)
	if err != nil || start.Replay || start.Claim.LeaseToken == "" {
		t.Fatalf("begin A: %+v %v", start, err)
	}
	claimA := start.Claim

	if _, err := r.ExecutionView(ctx, grantB, domain.Claim{}, execID); hostCode(err) != "not_authorized" {
		t.Fatalf("B views A's execution: %v", err)
	}
	if _, err := r.Finish(ctx, grantB, claimA, "completed", nil, 1); hostCode(err) != "not_authorized" {
		t.Fatalf("B finishes A's execution: %v", err)
	}
	if _, err := r.WorkspaceName(ctx, grantB, claimA); hostCode(err) != "execution_fenced" {
		t.Fatalf("B fences A's claim: %v", err)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM automation_executions WHERE grant_id = $1::uuid AND execution_id = $2::uuid`,
		grantA.ID, execID).Scan(&status); err != nil || status != "running" {
		t.Fatalf("A's row after B: %q %v", status, err)
	}

	name, err := r.WorkspaceName(ctx, grantA, claimA)
	if err != nil || name != nameA {
		t.Fatalf("A workspace name: %q %v", name, err)
	}
	env, err := r.Finish(ctx, grantA, claimA, "completed", nil, 1)
	if err != nil || env.Status != "completed" || env.ExecutionID != execID {
		t.Fatalf("A finish: %+v %v", env, err)
	}
	if _, err := r.ExecutionView(ctx, grantA, domain.Claim{}, execID); err != nil {
		t.Fatalf("A view: %v", err)
	}
	replay, err := r.Begin(ctx, grantA, execID, digestA, version)
	if err != nil || !replay.Replay || replay.Envelope.Status != "completed" {
		t.Fatalf("A replay: %+v %v", replay, err)
	}
	if _, err := r.Begin(ctx, grantA, execID, digestOther, version); hostCode(err) != "execution_id_conflict" {
		t.Fatalf("A conflicting replay: %v", err)
	}

	if _, err := pool.Exec(ctx, `UPDATE automation_grants SET revoked_at = clock_timestamp() WHERE id = $1::uuid`, grantB.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Begin(ctx, grantB, uuid.NewString(), digestOther, version); hostCode(err) != "not_authorized" {
		t.Fatalf("revoked B begin: %v", err)
	}
}

// countingPool never reaches a server. Each Begin dials, so the counter is
// the number of transactions the repo tried to open.
func countingPool(t *testing.T) (*pgxpool.Pool, *atomic.Int32) {
	t.Helper()
	cfg, err := pgxpool.ParseConfig("postgres://u:p@127.0.0.1:1/db?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	var dials atomic.Int32
	cfg.BeforeConnect = func(context.Context, *pgx.ConnConfig) error {
		dials.Add(1)
		return errors.New("no server")
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, &dials
}

func TestUnsetIDsOpenNoTransaction(t *testing.T) {
	pool, dials := countingPool(t)
	r := New(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	exec := uuid.NewString()
	ws := domain.Grant{ID: uuid.NewString(), ScopeKind: "workspace"}
	if _, err := r.WorkspaceName(ctx, ws, domain.Claim{}); hostCode(err) != "internal" {
		t.Fatalf("workspace org=0: %v", err)
	}
	blank := domain.Grant{ScopeKind: "workspace", OrgID: 1}
	if _, err := r.Begin(ctx, blank, exec, "d", "v"); hostCode(err) != "internal" {
		t.Fatalf("begin blank grant: %v", err)
	}
	if _, err := r.Finish(ctx, blank, domain.Claim{}, "completed", nil, 1); hostCode(err) != "internal" {
		t.Fatalf("finish blank grant: %v", err)
	}
	if _, err := r.ExecutionView(ctx, blank, domain.Claim{}, exec); hostCode(err) != "internal" {
		t.Fatalf("view blank grant: %v", err)
	}
	if n := dials.Load(); n != 0 {
		t.Fatalf("unset ids dialed %d times", n)
	}
	if _, err := r.ExecutionView(ctx, ws, domain.Claim{}, exec); hostCode(err) != "internal" {
		t.Fatalf("view with no server: %v", err)
	}
	if dials.Load() == 0 {
		t.Fatal("control call did not dial; the counter proves nothing")
	}
}
