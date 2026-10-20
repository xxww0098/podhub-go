package automationrepo

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/xxww0098/podhub-go/internal/automation/contract"
)

func TestMapDB(t *testing.T) {
	busy := mapDB(&pgconn.PgError{Code: "55P03"})
	var fault *contract.Fault
	if !errors.As(busy, &fault) || fault.Kind != "busy" || fault.Retry != 1 || fault.Message != contract.MsgBusy {
		t.Fatal(busy)
	}
	conflict := mapDB(&pgconn.PgError{Code: "P0M01"})
	if !errors.As(conflict, &fault) || fault.Kind != "conflict" || fault.Message != contract.MsgConflict {
		t.Fatal(conflict)
	}
	other := mapDB(&pgconn.PgError{Code: "23505"})
	if !errors.As(other, &fault) || fault.Kind != "unavailable" || fault.Message != contract.MsgUnavailable {
		t.Fatal(other)
	}
	if !errors.Is(mapDB(contract.ErrAuthority), contract.ErrAuthority) {
		t.Fatal("authority")
	}
	if !errors.Is(mapDB(contract.ErrMissing), contract.ErrMissing) {
		t.Fatal("missing")
	}
}
