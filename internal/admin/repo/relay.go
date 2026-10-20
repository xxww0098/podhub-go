package adminrepo

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// RelayRepo writes the seller-relay audit row outside the writer lease.
type RelayRepo struct {
	Pool *pgxpool.Pool
}

// Audit inserts one success row. The service ignores a failure.
func (r RelayRepo) Audit(ctx context.Context, a domain.Audit) error {
	if r.Pool == nil {
		return domain.Fail(500, "INTERNAL", "服务暂不可用")
	}
	tx, err := BeginAdmin(ctx, r.Pool)
	if err != nil {
		return mapAdmin(err, "INTERNAL")
	}
	defer tx.Rollback(ctx)
	defer endLease(tx)
	if err := InsertAudit(ctx, tx, a); err != nil {
		return mapAdmin(err, "INTERNAL")
	}
	return mapAdmin(tx.Commit(ctx), "INTERNAL")
}
