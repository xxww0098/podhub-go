package sellerrepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrRateLimited means the next GCRA slot sits past max wait. Nothing was spent.
var ErrRateLimited = errors.New("seller egress distributed budget rate limited")

// Reserve is LeaseStore::reserve. The SQL is RESERVE_SQL from src/lease/mod.rs
// at a03d735. The database clock is the only clock. A refused update does
// not move next_at.
func Reserve(ctx context.Context, pool *pgxpool.Pool, namespace, scope string, interval, burstWindow, maxWait time.Duration) (time.Duration, error) {
	if pool == nil {
		return 0, errors.New("lease budget pool is nil")
	}
	ttl := maxWait + burstWindow + interval
	rows, err := pool.Query(ctx, reserveSQL,
		namespace, scope,
		millis(burstWindow), millis(interval), millis(maxWait), millis(ttl),
	)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return 0, err
		}
		return 0, ErrRateLimited
	}
	var admitted bool
	var slotAt, dbNow time.Time
	if err := rows.Scan(&admitted, &slotAt, &dbNow); err != nil {
		return 0, err
	}
	wait := slotAt.Sub(dbNow)
	if wait < 0 {
		wait = 0
	}
	if !admitted {
		return wait, ErrRateLimited
	}
	return wait, nil
}

func millis(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

const reserveSQL = `
WITH ups AS (
    INSERT INTO public.lease_budget AS b (namespace, scope, next_at, expires_at)
    VALUES (
        $1, $2,
        clock_timestamp() - $3::float8 * INTERVAL '1 millisecond'
                          + $4::float8 * INTERVAL '1 millisecond',
        clock_timestamp() + $6::float8 * INTERVAL '1 millisecond'
    )
    ON CONFLICT (namespace, scope) DO UPDATE
        SET next_at = GREATEST(b.next_at,
                               clock_timestamp() - $3::float8 * INTERVAL '1 millisecond')
                      + $4::float8 * INTERVAL '1 millisecond',
            expires_at = clock_timestamp() + $6::float8 * INTERVAL '1 millisecond'
    WHERE GREATEST(b.next_at,
                   clock_timestamp() - $3::float8 * INTERVAL '1 millisecond')
          <= clock_timestamp() + $5::float8 * INTERVAL '1 millisecond'
    RETURNING next_at - $4::float8 * INTERVAL '1 millisecond' AS slot_at
)
SELECT TRUE AS admitted, slot_at, clock_timestamp() AS db_now FROM ups
UNION ALL
SELECT FALSE,
       GREATEST(b.next_at,
                clock_timestamp() - $3::float8 * INTERVAL '1 millisecond'),
       clock_timestamp()
FROM public.lease_budget AS b
WHERE b.namespace = $1 AND b.scope = $2
  AND NOT EXISTS (SELECT 1 FROM ups)
`
