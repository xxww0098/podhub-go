package catalogrepo

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

func TestMediaReadErrLock(t *testing.T) {
	err := mediaReadErr(&pgconn.PgError{Code: "55P03"})
	ae, ok := err.(*domain.APIError)
	if !ok || ae.Status != 503 || ae.Code != "MEDIA_UNAVAILABLE" || ae.Message != "资源正在更新，请稍后重试" || ae.RetryAfter != "1" {
		t.Fatalf("%v", err)
	}
	err = mediaReadErr(errors.New("db"))
	ae, ok = err.(*domain.APIError)
	if !ok || ae.Status != 503 || ae.Code != "MEDIA_UNAVAILABLE" || ae.Message != "服务暂不可用" {
		t.Fatalf("%v", err)
	}
}
