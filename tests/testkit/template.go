package testkit

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
)

// TemplateDatabase is the migrated database copied for each ordinary test.
const TemplateDatabase = "podhub_tpl"

// ErrDockerUnavailable is returned when the shared Postgres cannot start
// because the Docker socket is missing. Callers that used to skip keep skipping.
var ErrDockerUnavailable = errors.New("docker daemon is not available")

// MigrateFunc applies migrations to an empty database and closes every
// connection it opened before returning. Integration tests pass db.Migrate,
// including its allow-missing option. On an empty database that option
// applies every file in version order.
type MigrateFunc func(ctx context.Context, dsn string) error

// PrepareMigratedTemplate starts one Postgres container, creates
// TemplateDatabase, and runs migrate once. Later CloneMigrated calls copy
// that database. A second call does nothing once the template is ready.
//
// Roles are cluster-wide. A test that changes a role, raises a server
// setting, or applies only part of the migration history has to keep the
// private cluster from StartPostgres.
func PrepareMigratedTemplate(ctx context.Context, migrate MigrateFunc) error {
	if migrate == nil {
		return errors.New("migrate func is nil")
	}
	shared.mu.Lock()
	defer shared.mu.Unlock()
	if shared.ready {
		return nil
	}
	if !dockerAvailable() {
		return ErrDockerUnavailable
	}
	if shared.container == nil {
		container, err := postgres.Run(ctx, "postgres:16-alpine",
			postgres.WithDatabase("podhub"),
			postgres.WithUsername("postgres"),
			postgres.WithPassword("postgres"),
			postgres.BasicWaitStrategies(),
		)
		if err != nil {
			return err
		}
		dsn, err := container.ConnectionString(ctx, "sslmode=disable")
		if err != nil {
			_ = container.Terminate(context.Background())
			return err
		}
		shared.container = container
		shared.adminDSN = dsn
	}
	create := `CREATE DATABASE ` + quoteIdent(TemplateDatabase)
	if err := execSimple(ctx, shared.adminDSN, create); err != nil && !isPostgresCode(err, "42P04") {
		return fmt.Errorf("create template database: %w", err)
	}
	tpl, err := withDatabase(shared.adminDSN, TemplateDatabase)
	if err != nil {
		return err
	}
	if err := migrate(ctx, tpl); err != nil {
		_ = execSimple(context.Background(), shared.adminDSN, `DROP DATABASE IF EXISTS `+quoteIdent(TemplateDatabase)+` WITH (FORCE)`)
		return err
	}
	seal := `ALTER DATABASE ` + quoteIdent(TemplateDatabase) + ` WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`
	if err := execSimple(ctx, shared.adminDSN, seal); err != nil {
		return fmt.Errorf("seal template database: %w", err)
	}
	if err := terminateBackends(ctx, shared.adminDSN, TemplateDatabase); err != nil {
		return fmt.Errorf("disconnect template database: %w", err)
	}
	shared.ready = true
	return nil
}

// CloneMigrated returns a DSN for t_<n>, copied from TemplateDatabase, and a
// drop func. The caller closes its pool before drop. Drop terminates leftover
// sessions and removes the database.
func CloneMigrated(ctx context.Context) (dsn string, drop func() error, err error) {
	shared.mu.Lock()
	defer shared.mu.Unlock()
	if !shared.ready {
		return "", nil, errors.New("migrated template is not prepared")
	}
	shared.next++
	name := fmt.Sprintf("t_%d", shared.next)
	if err := createFromTemplate(ctx, shared.adminDSN, name); err != nil {
		return "", nil, err
	}
	dsn, err = withDatabase(shared.adminDSN, name)
	if err != nil {
		return "", nil, err
	}
	admin := shared.adminDSN
	drop = func() error {
		cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return execSimple(cctx, admin, `DROP DATABASE IF EXISTS `+quoteIdent(name)+` WITH (FORCE)`)
	}
	return dsn, drop, nil
}

// ShutdownSharedPostgres terminates the shared container if one was started.
func ShutdownSharedPostgres() {
	shared.mu.Lock()
	container := shared.container
	shared.container = nil
	shared.adminDSN = ""
	shared.ready = false
	shared.mu.Unlock()
	if container == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = container.Terminate(ctx)
}

type sharedPostgres struct {
	mu        sync.Mutex
	container *postgres.PostgresContainer
	adminDSN  string
	ready     bool
	next      int
}

var shared sharedPostgres

func createFromTemplate(ctx context.Context, adminDSN, name string) error {
	sql := `CREATE DATABASE ` + quoteIdent(name) + ` TEMPLATE ` + quoteIdent(TemplateDatabase)
	var last error
	for attempt := 0; attempt < 8; attempt++ {
		last = execSimple(ctx, adminDSN, sql)
		if last == nil {
			return nil
		}
		if !databaseInUse(last) {
			return last
		}
		_ = terminateBackends(ctx, adminDSN, TemplateDatabase)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(attempt+1) * 50 * time.Millisecond):
		}
	}
	return last
}

func terminateBackends(ctx context.Context, adminDSN, name string) error {
	conn, err := pgx.Connect(ctx, adminDSN)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, `
		SELECT pg_terminate_backend(pid)
		  FROM pg_stat_activity
		 WHERE datname = $1 AND pid <> pg_backend_pid()`, name)
	return err
}

func execSimple(ctx context.Context, dsn, sql string) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	return conn.PgConn().Exec(ctx, sql).Close()
}

func withDatabase(dsn, database string) (string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return "", err
	}
	if u.Scheme != "postgres" && u.Scheme != "postgresql" {
		return "", fmt.Errorf("dsn scheme %q", u.Scheme)
	}
	u.Path = "/" + database
	return u.String(), nil
}

func databaseInUse(err error) bool {
	if isPostgresCode(err, "55006") {
		return true
	}
	return strings.Contains(err.Error(), "being accessed by other users")
}

func isPostgresCode(err error, code string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == code
}
