// Package repo is the ops SQL. It does not decide Ozon business state.
package repo

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

// Store reads and writes ops rows. KeyReady is false when the KEK config is empty.
type Store struct {
	Pool     *pgxpool.Pool
	Ring     seal.Ring
	KeyReady bool
}

func New(pool *pgxpool.Pool, ring seal.Ring, keyReady bool) *Store {
	return &Store{Pool: pool, Ring: ring, KeyReady: keyReady}
}

func mapDB(err error, admission bool) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "55P03":
			return &contract.Fail{Status: 503, Code: contract.CodeInternal, Message: contract.MsgBusy, RetryAfter: "1"}
		case "P0M01":
			code := contract.CodeInternal
			if admission {
				code = contract.CodeConflict
			}
			return &contract.Fail{Status: 409, Code: code, Message: contract.MsgMediaGone}
		}
	}
	return &contract.Fail{Status: 500, Code: contract.CodeInternal, Message: contract.MsgUnavailable}
}
