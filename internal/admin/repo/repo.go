// Package adminrepo is the SQL for supplier admin, billing, and platform observation.
package adminrepo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

const (
	msgUnavailable = corerepo.MsgUnavailable
)

// Begin opens a podhub_app transaction. The process passes tenantx.BeginApp.
type Begin func(ctx context.Context, begin func(context.Context) (pgx.Tx, error), orgID int64) (pgx.Tx, error)

// Repo is the supplier store and the billing store.
// Supplier methods use pool and begin. Billing methods use Pool and Key.
type Repo struct {
	pool  *pgxpool.Pool
	begin Begin
	Pool  *pgxpool.Pool
	Key   string
	Now   func() time.Time
}

// New builds the supplier store. A nil pool fails closed inside withTx.
func New(pool *pgxpool.Pool, begin Begin) Repo {
	return Repo{pool: pool, begin: begin}
}

func NewBilling(pool *pgxpool.Pool, key string) *Repo {
	return &Repo{Pool: pool, Key: key, Now: time.Now}
}

func (r *Repo) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *Repo) beginTx(ctx context.Context) (pgx.Tx, error) {
	return r.Pool.Begin(ctx)
}

type lease struct {
	id    *int64
	fence *int64
}

func admit(ctx context.Context, tx pgx.Tx, domainName string, nowMS int64, disabled *domain.Fault) (lease, error) {
	held, err := corerepo.Admit(ctx, tx, domainName, nowMS, disabled)
	return lease{id: held.ID, fence: held.Fence}, err
}

func auditBill(ctx context.Context, tx pgx.Tx, orgID, userID int64, module, entityType, entityID, method, path, action, message string, held lease) error {
	return corerepo.AuditBill(ctx, tx, orgID, userID, module, entityType, entityID, method, path, action, message, corerepo.Lease{ID: held.id, Fence: held.fence})
}

func mapBill(err error, code string, lock bool) error {
	return corerepo.MapBill(err, code, lock)
}

func data(v any) ([]byte, error) {
	return corerepo.Data(v)
}

func (r *Repo) PublicID(ctx context.Context, userID int64) (string, error) {
	var id string
	err := db.InTx(ctx, r.Pool, db.AppRole(), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT public_id FROM account_users WHERE id = $1`, userID).Scan(&id)
	})
	if err != nil {
		return "", mapBill(err, "INTERNAL", true)
	}
	return id, nil
}

func orgAtLeast0(orgID int64) int64 { return corerepo.OrgAtLeast0(orgID) }

func (r Repo) beginCore() corerepo.Begin {
	if r.begin == nil {
		return nil
	}
	b := r.begin
	return func(ctx context.Context, begin func(context.Context) (pgx.Tx, error), orgID int64) (pgx.Tx, error) {
		return b(ctx, begin, orgID)
	}
}

func aesKey(raw string) []byte { return corerepo.AESKey(raw) }

func seal(key, plain []byte) (nonce, ciphertext []byte, err error) {
	return corerepo.Seal(key, plain)
}

func open(key, nonce, ciphertext []byte) ([]byte, error) {
	return corerepo.Open(key, nonce, ciphertext)
}

func (r Repo) withTx(ctx context.Context, orgID int64, fn func(pgx.Tx) error) error {
	return corerepo.WithTx(ctx, r.pool, r.beginCore(), orgID, fn)
}

func (r Repo) identity(ctx context.Context, tx pgx.Tx, actor contract.Actor) (publicID string, owner *string, err error) {
	return corerepo.Identity(ctx, tx, actor)
}

func audit(ctx context.Context, tx pgx.Tx, actor contract.Actor, module, entityType, entityID, method, path, action, message string) error {
	return corerepo.Audit(ctx, tx, actor, module, entityType, entityID, method, path, action, message)
}

func internal() *contract.Fail { return corerepo.Internal() }

func notFound(message string) *contract.Fail { return corerepo.NotFound(message) }

func conflict(message string) *contract.Fail { return corerepo.Conflict(message) }

func forbidden(message string) *contract.Fail { return corerepo.Forbidden(message) }

func mapDB(err error) error { return corerepo.MapDB(err) }

func constraint(err error) string { return corerepo.Constraint(err) }

func isFK(err error) bool { return corerepo.IsFK(err) }
