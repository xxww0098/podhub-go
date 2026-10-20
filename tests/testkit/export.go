package testkit

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// These names exist so tests/integration can call the helpers without
// changing the helper bodies. The functions below only forward.

func DockerAvailable() bool { return dockerAvailable() }

func CompareHeadFingerprint(t failer, ctx context.Context, pool *pgxpool.Pool) {
	compareHeadFingerprint(t, ctx, pool)
}

func CompareRoutineBodies(t failer, ctx context.Context, pool *pgxpool.Pool) {
	compareRoutineBodies(t, ctx, pool)
}

func QuoteIdent(name string) string { return quoteIdent(name) }
