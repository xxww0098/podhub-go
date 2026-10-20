// Package adminrepo is the SQL for admin users, grants, leases, prices, and TOTP.
package adminrepo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// ProcessHolder is HOLDER_AXUM. The instance id comes from CLOUD_INSTANCE_ID.
const ProcessHolder = writer.HolderAxum

// Store runs admin SQL on one pool. These statements do not set
// app.current_org_id except the dissolve and wallet reads the spec names.
type Store struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

func NewStore(pool *pgxpool.Pool, now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{pool: pool, now: now}
}

func (s *Store) Now() time.Time {
	if s == nil || s.now == nil {
		return time.Now()
	}
	return s.now()
}

func dbFault(err error) *contract.Fault { return corerepo.DBFault(err) }

func plainFault(err error) *contract.Fault { return corerepo.PlainFault(err) }

type auditRow = corerepo.AuditRow

func insertAudit(ctx context.Context, tx pgx.Tx, row auditRow) error {
	return corerepo.InsertAudit(ctx, tx, row)
}

func (s *Store) auditAfter(ctx context.Context, row auditRow) error {
	return corerepo.AuditAfter(ctx, s.pool, row)
}

// withGate runs fn inside an admin or auth writer lease transaction.
// fn must record an audit or the transaction rolls back.
func (s *Store) withGate(ctx context.Context, domain, disabled string, fn func(context.Context, pgx.Tx) error) *contract.Fault {
	return corerepo.WithGate(ctx, s.pool, s.Now, domain, disabled, fn)
}

func writeAudit(ctx context.Context, tx pgx.Tx, row auditRow) error {
	return corerepo.WriteAudit(ctx, tx, row)
}

func orgFloor(id int64) int64 { return corerepo.OrgFloor(id) }

// endLease drops the lease stamp remembered on this transaction. A pooled
// pgx.Tx can be reused, so every begin must forget before the pointer escapes.
func endLease(tx pgx.Tx) { corerepo.EndLease(tx) }
