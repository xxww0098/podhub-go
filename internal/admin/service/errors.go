package service

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

// Fail is an admin or integration error body. RetryAfter is set only for 55P03.
type Fail struct {
	Status     int
	Code       string
	Message    string
	RetryAfter string
}

func (f *Fail) Error() string { return f.Message }

func fail(status int, code, message string) *Fail {
	return &Fail{Status: status, Code: code, Message: message}
}

func mapDB(err error, status int, code, message string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "55P03":
			return &Fail{Status: httpStatusLocked, Code: code, Message: "资源正在更新，请稍后重试", RetryAfter: "1"}
		case "P0M01":
			return &Fail{Status: httpStatusConflict, Code: code, Message: "媒体对象已进入回收，请重新上传"}
		}
	}
	return fail(status, code, message)
}

func unique(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}

const (
	httpStatusConflict = 409
	httpStatusLocked   = 503
)

// MapDatabase applies from_db_err. The code argument is kept for 55P03 and P0M01.
func MapDatabase(err error, status int, code, message string) error {
	return mapDB(err, status, code, message)
}

// NewFail builds an admin error the HTTP layer can return from a ticket check.
func NewFail(status int, code, message string) *Fail { return fail(status, code, message) }

// AsFail reports a typed failure.
func AsFail(err error) (*Fail, bool) {
	var f *Fail
	if errors.As(err, &f) {
		return f, true
	}
	return nil, false
}
