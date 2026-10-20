// Package agentrepo is the pgx store for the seven agent routes.
// Agent tables have no RLS. Reads are autocommit on the pool user, matching
// the Rust handlers that do not open a tenant transaction. Writes SET ROLE
// podhub_app for the whole transaction: m20260920_000329 already grants
// account_users, audit_logs, and writer_leases. The auth advisory lock and
// the writer-lease gate run as that role, then one audit row is inserted.
package agentrepo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// Repo is the agent store. A nil pool fails every call with the internal
// failure the HTTP layer turns into 500.
type Repo struct {
	pool *pgxpool.Pool
}

// New binds the pool. nil is allowed and fails closed.
func New(pool *pgxpool.Pool) *Repo {
	return &Repo{pool: pool}
}

func (r *Repo) ready() error {
	if r == nil || r.pool == nil {
		return contract.Fail(contract.KindInternal, "服务暂不可用")
	}
	return nil
}

func mapDB(err error) error {
	if err == nil {
		return nil
	}
	var f *contract.Failure
	if errors.As(err, &f) {
		return f
	}
	slog.Error("agent db", "err", err)
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "55P03":
			return contract.FailBusy()
		case "P0M01":
			return contract.Fail(contract.KindMedia, "媒体对象已进入回收，请重新上传")
		}
	}
	return contract.Fail(contract.KindInternal, "服务暂不可用")
}

type auditSink struct {
	tx pgx.Tx
	n  int
}

func (s *auditSink) record(ctx context.Context, orgID, userID int64, entityType, entityID, method, path, action string, message any) error {
	raw, err := auditJSON(message)
	if err != nil {
		return err
	}
	if orgID < 0 {
		orgID = 0
	}
	s.n++
	leaseID, fence := writer.AuditArgs(s.tx)
	_, err = s.tx.Exec(ctx, `
		INSERT INTO audit_logs (
			org_id, user_id, module, entity_type, entity_id, api_method, api_path,
			action, status, result, message, shop_id, created_at_ms, created_at,
			actor_kind, support_grant_id, writer_lease_id, writer_fence_token)
		VALUES (
			$1, $2, 'agents', $3, $4, $5, $6,
			$7, 'success', 'applied', $8, NULL,
			(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
			clock_timestamp(), 'user', NULL, $9, $10)`,
		orgID, userID, entityType, entityID, method, path, action, string(raw), leaseID, fence)
	return err
}

func auditJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// write runs fn as podhub_app under the auth writer lease. fn must record an audit row.
func (r *Repo) write(ctx context.Context, fn func(tx pgx.Tx, sink *auditSink) error) error {
	if err := r.ready(); err != nil {
		return err
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return mapDB(err)
	}
	defer tx.Rollback(ctx)
	defer writer.Forget(tx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		return mapDB(err)
	}
	if _, err := writer.Assert(ctx, tx, writer.DomainAuth, writer.ProcessIdentity(), time.Now().UnixMilli(), "认证域写入未启用"); err != nil {
		if writer.IsDisabled(err) {
			return contract.Fail(contract.KindDisabled, "认证域写入未启用")
		}
		return mapDB(err)
	}
	sink := &auditSink{tx: tx}
	if err := fn(tx, sink); err != nil {
		return mapDB(err)
	}
	if sink.n == 0 {
		return contract.Fail(contract.KindInternal, "服务暂不可用")
	}
	if err := tx.Commit(ctx); err != nil {
		return mapDB(err)
	}
	return nil
}
