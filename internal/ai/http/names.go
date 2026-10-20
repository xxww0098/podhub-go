package aihttp

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/ai/service"
	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
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

func Stamp(body []byte, model string) ([]byte, error) { return service.Stamp(body, model) }

func ParseUsage(completion []byte) (billing.Usage, string, error) {
	return service.ParseUsage(completion)
}

func FoldCompletion(body []byte) (json.RawMessage, error) {
	return service.FoldCompletion(body)
}

func LimitsFromEnv() Limits { return service.LimitsFromEnv() }

func EstimatePromptTokens(body []byte) int { return service.EstimatePromptTokens(body) }

func Acquire(ctx context.Context, pool *pgxpool.Pool, limits Limits, userID int64, account string, includeGlobal bool) (Lease, int, string) {
	return service.Acquire(ctx, pool, limits, userID, account, includeGlobal)
}
