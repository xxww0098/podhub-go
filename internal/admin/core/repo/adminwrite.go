package corerepo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// AssertWriteLease is the admin-domain fence. disabledMessage is the call-site 503 text.
func AssertWriteLease(ctx context.Context, tx pgx.Tx, disabledMessage string) error {
	_, err := writer.Assert(ctx, tx, "admin", writer.ProcessIdentity(), time.Now().UnixMilli(), disabledMessage)
	if writer.IsDisabled(err) {
		return contract.Fail(503, "WRITES_DISABLED", disabledMessage)
	}
	if err != nil {
		return MapAdmin(err, "INTERNAL")
	}
	return nil
}
