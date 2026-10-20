package adminrepo

import (
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

func TestMapBillLockTimeout(t *testing.T) {
	err := mapBill(&pgconn.PgError{Code: "55P03"}, "INTERNAL", true)
	fault, ok := err.(*domain.Fault)
	if !ok || fault.Kind != "locked" || fault.Code != "INTERNAL" || fault.Message != "资源正在更新，请稍后重试" {
		t.Fatalf("%#v", err)
	}
}
