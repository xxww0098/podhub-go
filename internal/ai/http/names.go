package aihttp

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/ai/service"
	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/platform/aiclient"
)

// Same-package names for symbols that live in service, so relay.go and
// handler.go keep the bodies they had in package ai.
type (
	Limits = service.Limits
	Lease  = service.Lease
)

// errInvalid is the same sentinel stamp.go and usage.go return.
var errInvalid = service.Invalid()

func Key(raw string) (string, bool) { return service.Key(raw) }

func ParseUsage(format aiclient.Format, completion []byte) (billing.Usage, string, error) {
	return service.ParseUsage(format, completion)
}

func FoldCompletion(body []byte) (json.RawMessage, error) {
	return service.FoldCompletion(body)
}

func Acquire(ctx context.Context, pool *pgxpool.Pool, limits Limits, userID int64, account string, includeGlobal bool) (Lease, int, string) {
	return service.Acquire(ctx, pool, limits, userID, account, includeGlobal)
}
