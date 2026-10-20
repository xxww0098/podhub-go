package corerepo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/admin/core/contract/apifault"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

func DBFault(err error) *apifault.Fault {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "55P03":
			return &apifault.Fault{Status: 503, Code: "INTERNAL", Message: "资源正在更新，请稍后重试", RetryAfter: 1}
		case "P0M01":
			return &apifault.Fault{Status: 409, Code: "INTERNAL", Message: "媒体对象已进入回收，请重新上传"}
		}
	}
	return apifault.Internal("服务暂不可用")
}

func PlainFault(err error) *apifault.Fault {
	if err == nil {
		return nil
	}
	if f, ok := apifault.AsFault(err); ok {
		return f
	}
	return apifault.Internal("服务暂不可用")
}

type AuditRow struct {
	OrgID, UserID                 int64
	Module, EntityType, EntityID  string
	Method, Path, Action, Message string
}

func InsertAudit(ctx context.Context, tx pgx.Tx, row AuditRow) error {
	leaseID, fence := writer.AuditArgs(tx)
	_, err := tx.Exec(ctx, `
INSERT INTO audit_logs
       (org_id, user_id, module, entity_type, entity_id, api_method, api_path,
        action, status, result, message, shop_id, created_at_ms, created_at,
        actor_kind, support_grant_id, writer_lease_id, writer_fence_token)
VALUES ($1, $2, $3, $4, $5, $6, $7,
        $8, 'success', 'applied', $9, NULL,
        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
        clock_timestamp(), 'user', NULL, $10, $11)`,
		row.OrgID, row.UserID, row.Module, row.EntityType, row.EntityID,
		row.Method, row.Path, row.Action, row.Message, leaseID, fence)
	return err
}

func AuditAfter(ctx context.Context, pool *pgxpool.Pool, row AuditRow) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	defer EndLease(tx)
	if err := InsertAudit(ctx, tx, row); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// WithGate runs fn inside an admin or auth writer lease transaction.
// fn must record an audit or the transaction rolls back.
func WithGate(ctx context.Context, pool *pgxpool.Pool, now func() time.Time, domain, disabled string, fn func(context.Context, pgx.Tx) error) *apifault.Fault {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return DBFault(err)
	}
	defer tx.Rollback(ctx)
	defer EndLease(tx)
	defer writer.Forget(tx)
	if fault := AssertAuthority(ctx, tx, now, domain, disabled); fault != nil {
		return fault
	}
	audited := false
	ctx = context.WithValue(ctx, auditKey{}, &audited)
	err = fn(ctx, tx)
	if err != nil {
		if f, ok := apifault.AsFault(err); ok {
			return f
		}
		return DBFault(err)
	}
	if !audited {
		return apifault.Internal("服务暂不可用")
	}
	if err := tx.Commit(ctx); err != nil {
		return DBFault(err)
	}
	return nil
}

type auditKey struct{}

func markAudit(ctx context.Context) {
	if p, ok := ctx.Value(auditKey{}).(*bool); ok && p != nil {
		*p = true
	}
}

// WriteAudit inserts the row and marks the WithGate transaction audited.
func WriteAudit(ctx context.Context, tx pgx.Tx, row AuditRow) error {
	if err := InsertAudit(ctx, tx, row); err != nil {
		return err
	}
	markAudit(ctx)
	return nil
}

func AssertAuthority(ctx context.Context, tx pgx.Tx, now func() time.Time, domain, disabled string) *apifault.Fault {
	_, err := writer.Assert(ctx, tx, domain, writer.ProcessIdentity(), now().UnixMilli(), disabled)
	if writer.IsDisabled(err) {
		return apifault.Unavailable("WRITES_DISABLED", disabled)
	}
	if err != nil {
		return DBFault(err)
	}
	return nil
}

func OrgFloor(id int64) int64 {
	if id < 0 {
		return 0
	}
	return id
}

func JSONText(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	b := buf.Bytes()
	if len(b) > 0 && b[len(b)-1] == '\n' {
		b = b[:len(b)-1]
	}
	return string(b)
}
