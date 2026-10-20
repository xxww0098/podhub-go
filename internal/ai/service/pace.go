package service

import (
	"context"
	"crypto/rand"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

const (
	leaseNamespace = "ai-lease"
	windowMillis   = 60_000
)

// Limits are the AI lease ceilings. Zero means that ceiling is off.
type Limits struct {
	Global    uint32
	User      uint32
	Account   uint32
	PerMinute uint32
	LeaseTTL  time.Duration
}

// LimitsFromEnv reads the CLOUD_AI_* ceilings. Zero, blank, and invalid values
// use the default. The lease TTL default is 90s even when the env is 0.
func LimitsFromEnv() Limits {
	l := config.AILimitsFromEnv()
	return Limits{
		Global:    l.Global,
		User:      l.User,
		Account:   l.Account,
		PerMinute: l.PerMinute,
		LeaseTTL:  time.Duration(l.LeaseTTLSeconds) * time.Second,
	}
}

type slot struct {
	scope string
	token []byte
}

// Lease is a set of held slots. Release deletes them. A zero lease holds nothing.
type Lease struct {
	pool  *pgxpool.Pool
	slots []slot
}

// Release drops the slots. The rate-window count is not returned.
func (l Lease) Release(ctx context.Context) {
	if l.pool == nil || len(l.slots) == 0 {
		return
	}
	tx, err := l.pool.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		return
	}
	for _, item := range l.slots {
		_, _ = tx.Exec(ctx, `DELETE FROM lease_slot WHERE namespace = $1 AND scope = $2 AND token = $3`, leaseNamespace, item.scope, item.token)
	}
	_, _ = tx.Exec(ctx, `RESET ROLE`)
	_ = tx.Commit(ctx)
}

// Acquire takes the per-minute window first, then slots. A rate refusal writes
// no count. A later slot refusal keeps the count. All limits at zero write nothing.
func Acquire(ctx context.Context, pool *pgxpool.Pool, limits Limits, userID int64, account string, includeGlobal bool) (Lease, int, string) {
	if limits.LeaseTTL <= 0 {
		limits.LeaseTTL = 90 * time.Second
	}
	if limits.PerMinute > 0 {
		ok, err := takeRate(ctx, pool, userID, limits.PerMinute)
		if err != nil {
			return Lease{}, 503, "服务暂不可用"
		}
		if !ok {
			return Lease{}, 429, "AI 请求过于频繁，请稍后重试"
		}
	}
	type scope struct {
		name     string
		capacity uint32
		message  string
	}
	var scopes []scope
	if includeGlobal && limits.Global > 0 {
		scopes = append(scopes, scope{"global", limits.Global, "AI 服务当前并发已满，请稍后重试"})
	}
	if limits.User > 0 {
		scopes = append(scopes, scope{"user:" + strconv.FormatInt(userID, 10), limits.User, "当前用户的 AI 并发已达上限，请稍后重试"})
	}
	if limits.Account > 0 && account != "" {
		scopes = append(scopes, scope{"account:" + account, limits.Account, "AI 上游账户并发已达上限，请稍后重试"})
	}
	if len(scopes) == 0 {
		return Lease{}, 0, ""
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Lease{}, 503, "服务暂不可用"
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		return Lease{}, 503, "服务暂不可用"
	}
	var held []slot
	for _, item := range scopes {
		token := make([]byte, 16)
		if _, err := rand.Read(token); err != nil {
			return Lease{}, 503, "服务暂不可用"
		}
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, leaseNamespace, item.name); err != nil {
			return Lease{}, 503, "服务暂不可用"
		}
		var got []byte
		err := tx.QueryRow(ctx, `
			INSERT INTO public.lease_slot (namespace, scope, token, expires_at)
			SELECT $1, $2, $3, clock_timestamp() + $4::float8 * INTERVAL '1 millisecond'
			WHERE EXISTS (
			          SELECT 1 FROM public.lease_slot
			           WHERE namespace = $1 AND scope = $2 AND token = $3
			             AND expires_at > clock_timestamp()
			      )
			      OR (SELECT count(*) FROM public.lease_slot
			           WHERE namespace = $1 AND scope = $2
			             AND expires_at > clock_timestamp()) < $5
			ON CONFLICT (namespace, scope, token) DO UPDATE
			    SET expires_at = EXCLUDED.expires_at
			RETURNING token`, leaseNamespace, item.name, token, float64(limits.LeaseTTL/time.Millisecond), item.capacity).Scan(&got)
		if err != nil {
			if err == pgx.ErrNoRows {
				return Lease{}, 429, item.message
			}
			return Lease{}, 503, "服务暂不可用"
		}
		held = append(held, slot{scope: item.name, token: got})
	}
	if _, err := tx.Exec(ctx, `RESET ROLE`); err != nil {
		return Lease{}, 503, "服务暂不可用"
	}
	if err := tx.Commit(ctx); err != nil {
		return Lease{}, 503, "服务暂不可用"
	}
	return Lease{pool: pool, slots: held}, 0, ""
}

func takeRate(ctx context.Context, pool *pgxpool.Pool, userID int64, limit uint32) (bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		return false, err
	}
	var count int64
	err = tx.QueryRow(ctx, `
		INSERT INTO public.lease_window AS w (namespace, scope, window_start, count, expires_at)
		SELECT $1, $2, win.start, 1, win.start + $3::float8 * INTERVAL '1 millisecond'
		  FROM (
		      SELECT date_bin($3::float8 * INTERVAL '1 millisecond', clock_timestamp(), '1970-01-01 00:00:00+00'::timestamptz) AS start
		  ) AS win
		 WHERE $4 > 0
		ON CONFLICT (namespace, scope, window_start) DO UPDATE
		    SET count = w.count + 1, expires_at = EXCLUDED.expires_at
		    WHERE w.count < $4
		RETURNING count`, leaseNamespace, "rate:user:"+strconv.FormatInt(userID, 10), float64(windowMillis), limit).Scan(&count)
	if err == pgx.ErrNoRows {
		_ = tx.Commit(ctx)
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `RESET ROLE`); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}
