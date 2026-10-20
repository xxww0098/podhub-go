package service

import (
	"context"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

const (
	adminDomain = "admin"
	auditSQL    = `INSERT INTO audit_logs
    (org_id, user_id, module, entity_type, entity_id, api_method, api_path,
     action, status, result, message, shop_id, created_at_ms, created_at,
     actor_kind, support_grant_id, writer_lease_id, writer_fence_token)
VALUES ($1, $2, $3, $4, $5, $6, $7,
        $8, 'success', 'applied', $9, NULL,
        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
        clock_timestamp(), 'user', NULL, $10, $11)`
)

// Lease is the admin writer lease held for one transaction. Both pointers
// are nil when the domain has never been leased.
type Lease struct {
	ID    *int64
	Fence *int64
}

type execer interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

type gate struct {
	tx pgx.Tx
	Lease
	n int
}

func (d Deps) pool() *pgxpool.Pool { return d.Pool }

func (d Deps) under(ctx context.Context, disabled string, fn func(*gate) error) error {
	if d.Pool == nil {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return mapDB(err, 500, "INTERNAL", "服务暂不可用")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	defer writer.Forget(tx)
	now := d.nowMS()
	id := writer.Identity{Holder: d.Holder, InstanceID: d.Instance}
	if id.Holder == "" {
		id.Holder = writer.HolderAxum
	}
	if id.InstanceID == "" {
		id.InstanceID = writer.ProcessIdentity().InstanceID
	}
	held, err := writer.Assert(ctx, tx, adminDomain, id, now, disabled)
	g := &gate{tx: tx, Lease: Lease{ID: held.ID, Fence: held.Fence}}
	if writer.IsDisabled(err) {
		return fail(503, "WRITES_DISABLED", disabled)
	}
	if err != nil {
		return mapDB(err, 500, "INTERNAL", "服务暂不可用")
	}
	if err = fn(g); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		if _, ok := AsFail(err); ok {
			return err
		}
		return mapDB(err, 500, "INTERNAL", "服务暂不可用")
	}
	if g.n == 0 {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	if err = tx.Commit(ctx); err != nil {
		return mapDB(err, 500, "INTERNAL", "服务暂不可用")
	}
	return nil
}

func (g *gate) audit(ctx context.Context, org, user int64, module, entity, entityID, method, path, action string, message map[string]any) error {
	return writeAudit(ctx, g.tx, g.Lease, org, user, module, entity, entityID, method, path, action, message, &g.n)
}

func writeAudit(ctx context.Context, q execer, lease Lease, org, user int64, module, entity, entityID, method, path, action string, message map[string]any, n *int) error {
	raw, err := jsonwire.Marshal(message)
	if err != nil {
		return err
	}
	var leaseID, fence any
	if lease.ID != nil {
		leaseID = *lease.ID
		fence = *lease.Fence
	}
	tag, err := q.Exec(ctx, auditSQL, org, user, module, entity, entityID, method, path, action, string(raw), leaseID, fence)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		slog.Error("audit insert wrote no row", "action", action)
		return errors.New("audit")
	}
	if n != nil {
		*n++
	}
	return nil
}

func (d Deps) audit(ctx context.Context, org, user int64, module, entity, entityID, method, path, action string, message map[string]any) error {
	if d.Pool == nil {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	err := writeAudit(ctx, d.Pool, Lease{}, org, user, module, entity, entityID, method, path, action, message, nil)
	if err != nil {
		if _, ok := AsFail(err); ok {
			return err
		}
		return mapDB(err, 500, "INTERNAL", "服务暂不可用")
	}
	return nil
}
