package adminrepo

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

type digestWire struct {
	Fingerprint   string    `json:"fingerprint"`
	RouteTemplate string    `json:"route_template"`
	StatusCode    int       `json:"status_code"`
	Count         int64     `json:"count"`
	FirstAt       time.Time `json:"first_at"`
	LastAt        time.Time `json:"last_at"`
	Summary       string    `json:"summary"`
}

// ListDigest returns platform error_digest rows for a super admin.
// The selected columns are the redacted projection: no org id, email, payload,
// or request body.
func (r *Repo) ListDigest(ctx context.Context, actor domain.Actor) ([]byte, error) {
	if r == nil || r.Pool == nil {
		return nil, domain.Internal("INTERNAL", "错误摘要读取失败")
	}
	out := []digestWire{}
	err := openDigest(ctx, r.Pool, actor.UserID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
		SELECT fingerprint, route_template, status_code, event_count, first_at, last_at, summary
		  FROM public.error_digest
		 WHERE org_id IS NULL
		 ORDER BY last_at DESC, fingerprint
		 LIMIT 200`)
		if err != nil {
			return err
		}
		defer rows.Close()
		scanned := []digestWire{}
		for rows.Next() {
			var row digestWire
			if err := rows.Scan(&row.Fingerprint, &row.RouteTemplate, &row.StatusCode, &row.Count, &row.FirstAt, &row.LastAt, &row.Summary); err != nil {
				return err
			}
			scanned = append(scanned, row)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		out = scanned
		return nil
	})
	if err != nil {
		return nil, domain.Internal("INTERNAL", "错误摘要读取失败")
	}
	body, err := json.Marshal(struct {
		Data struct {
			Digests []digestWire `json:"digests"`
		} `json:"data"`
	}{Data: struct {
		Digests []digestWire `json:"digests"`
	}{Digests: out}})
	if err != nil {
		return nil, domain.Internal("INTERNAL", "错误摘要读取失败")
	}
	return body, nil
}

// openDigest enters podhub_app and app.platform_observer_id.
// A positive user id uses InTx Observer. Zero and negative ids still open a
// transaction and store the decimal id, because InTx rejects them before Begin.
func openDigest(ctx context.Context, pool *pgxpool.Pool, userID int64, fn func(pgx.Tx) error) error {
	if userID > 0 {
		return db.InTx(ctx, pool, db.Observer(userID), fn)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tenantx.EnterObserver(ctx, tx, userID); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
