package supplyrepo

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/xxww0098/podhub-go/internal/supply/contract"
)

func fail(status int, code, message string) *contract.Failure {
	return contract.Fail(status, code, message)
}

func mapDB(err error) error {
	if err == nil {
		return nil
	}
	if _, ok := contract.AsFailure(err); ok {
		return err
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "55P03":
			f := fail(503, "INTERNAL", "资源正在更新，请稍后重试")
			f.RetryAfter = "1"
			return f
		case "P0M01":
			return fail(409, "INTERNAL", "媒体对象已进入回收，请重新上传")
		}
	}
	return fail(500, "INTERNAL", "服务暂不可用")
}

func isUnique(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}
