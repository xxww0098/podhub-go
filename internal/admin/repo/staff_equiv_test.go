package adminrepo

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

type legacyAPIError struct {
	Status     int
	Code       string
	Message    string
	RetryAfter string
}

// legacyMapAdmin is the admin/repo mapAdmin body before it moved to
// admin/core/repo. A passed-through *domain.APIError is returned as passed.
func legacyMapAdmin(err error, code string) (passed error, built *legacyAPIError) {
	if err == nil {
		return nil, nil
	}
	var ae *domain.APIError
	if errors.As(err, &ae) {
		return ae, nil
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "55P03":
			return nil, &legacyAPIError{Status: 503, Code: code, Message: "资源正在更新，请稍后重试", RetryAfter: "1"}
		case "P0M01":
			return nil, &legacyAPIError{Status: 409, Code: code, Message: "媒体对象已进入回收，请重新上传"}
		}
	}
	return nil, &legacyAPIError{Status: 500, Code: code, Message: "服务暂不可用"}
}

func TestMapAdminMatchesLegacy(t *testing.T) {
	own := domain.Fail(404, "not_found", "委托单不存在")
	cases := []struct {
		name string
		err  error
		code string
	}{
		{"nil", nil, "internal"},
		{"api error", own, "internal"},
		{"wrapped api error", fmt.Errorf("wrap: %w", own), "INTERNAL"},
		{"lock", &pgconn.PgError{Code: "55P03"}, "internal"},
		{"wrapped lock", fmt.Errorf("x: %w", &pgconn.PgError{Code: "55P03"}), "INTERNAL"},
		{"media", &pgconn.PgError{Code: "P0M01"}, "internal"},
		{"other pg", &pgconn.PgError{Code: "23505"}, "internal"},
		{"plain", errors.New("boom"), "INTERNAL"},
		{"fault is not api error", corecontract.Internal("INTERNAL", "x"), "internal"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := mapAdmin(c.err, c.code)
			passed, built := legacyMapAdmin(c.err, c.code)
			switch {
			case c.err == nil:
				if got != nil {
					t.Fatalf("got %v", got)
				}
			case passed != nil:
				if got != passed {
					t.Fatalf("got %#v want the same pointer %#v", got, passed)
				}
			default:
				ae, ok := got.(*domain.APIError)
				if !ok {
					t.Fatalf("got %T", got)
				}
				if *built != (legacyAPIError{Status: ae.Status, Code: ae.Code, Message: ae.Message, RetryAfter: ae.RetryAfter}) {
					t.Fatalf("got %+v want %+v", *ae, *built)
				}
			}
		})
	}
}
