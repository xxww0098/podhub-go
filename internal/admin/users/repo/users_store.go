package usersrepo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	contract "github.com/xxww0098/podhub-go/internal/admin/core/contract/apifault"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
)

// Users is the account directory, roles, passwords, and seats store.
type Users struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

func NewUsers(pool *pgxpool.Pool, now func() time.Time) *Users {
	if now == nil {
		now = time.Now
	}
	return &Users{pool: pool, now: now}
}

func (s *Users) Now() time.Time {
	if s == nil || s.now == nil {
		return time.Now()
	}
	return s.now()
}

func (s *Users) auditAfter(ctx context.Context, row corerepo.AuditRow) error {
	return corerepo.AuditAfter(ctx, s.pool, row)
}

// withGate runs fn inside an admin or auth writer lease transaction.
// fn must record an audit or the transaction rolls back.
func (s *Users) withGate(ctx context.Context, domain, disabled string, fn func(context.Context, pgx.Tx) error) *contract.Fault {
	return corerepo.WithGate(ctx, s.pool, s.Now, domain, disabled, fn)
}
