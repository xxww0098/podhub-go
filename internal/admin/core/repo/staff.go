package corerepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/admin/core/contract"
)

// BeginAdmin starts a transaction and sets the local role to podhub_app.
func BeginAdmin(ctx context.Context, pool *pgxpool.Pool) (pgx.Tx, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// BeginStaff sets podhub_app and app.staff_access. It does not set current_org_id.
func BeginStaff(ctx context.Context, pool *pgxpool.Pool) (pgx.Tx, error) {
	tx, err := BeginAdmin(ctx, pool)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.staff_access', '1', true)`); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// MapAdmin rewrites lock and media SQLSTATEs. The caller's code is preserved.
func MapAdmin(err error, code string) error {
	if err == nil {
		return nil
	}
	var ae *contract.APIError
	if errors.As(err, &ae) {
		return ae
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "55P03":
			return &contract.APIError{Status: 503, Code: code, Message: "资源正在更新，请稍后重试", RetryAfter: "1"}
		case "P0M01":
			return &contract.APIError{Status: 409, Code: code, Message: "媒体对象已进入回收，请重新上传"}
		}
	}
	return contract.Fail(500, code, "服务暂不可用")
}
