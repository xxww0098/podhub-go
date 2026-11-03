package reaper

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

const (
	strandedAfterSeconds  = 900
	responseRetentionDays = 7
	reaperBatch           = 200
)

// ReleaseTx is the wallet release the sweep needs. The signature matches the
// billing repo function internal/app passes in.
type ReleaseTx func(ctx context.Context, tx pgx.Tx, orgID int64, key string, request *int64, held int64, note string) (billing.WalletRow, error)

// errReleaseNotWired is the refusal when the release port was not assembled.
var errReleaseNotWired = errors.New("wallet release is not wired")

type stranded struct {
	ID       int64
	PublicID string
	OrgID    int64
	Held     int64
	Updated  time.Time
}

// SweepStranded closes held and dispatching rows older than 900 seconds.
// The wallet release note is stranded_request. This is not started by River.
// The scan is cross-tenant, so it runs as podhub_maintenance; closing one row
// enters that row's org under podhub_app and is the only writer.
func SweepStranded(ctx context.Context, pool *pgxpool.Pool, release ReleaseTx) (int, error) {
	var found []stranded
	err := db.InTx(ctx, pool, db.Maintenance(), func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, public_id, org_id, held_microfen, updated_at
			  FROM ai_requests
			 WHERE status IN ('held', 'dispatching')
			   AND updated_at < clock_timestamp() - ($1 || ' seconds')::interval
			 ORDER BY id
			 LIMIT 200`, "900")
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row stranded
			if err := rows.Scan(&row.ID, &row.PublicID, &row.OrgID, &row.Held, &row.Updated); err != nil {
				return err
			}
			found = append(found, row)
		}
		return rows.Err()
	})
	if err != nil {
		return 0, err
	}
	var closed int
	for _, row := range found {
		ok, err := closeStranded(ctx, pool, release, row)
		if err != nil {
			continue
		}
		if ok {
			closed++
		}
	}
	return closed, nil
}

func closeStranded(ctx context.Context, pool *pgxpool.Pool, release ReleaseTx, row stranded) (bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() {
		_ = tx.Rollback(ctx)
		writer.Forget(tx)
	}()
	if err := tenantx.EnterApp(ctx, tx, row.OrgID); err != nil {
		return false, err
	}
	if _, err := writer.Assert(ctx, tx, "billing", writer.ProcessIdentity(), time.Now().UnixMilli(), "计费写入未启用"); err != nil {
		return false, err
	}
	var id int64
	err = tx.QueryRow(ctx, `
		SELECT id FROM ai_requests
		 WHERE id = $1 AND status IN ('held', 'dispatching') AND updated_at = $2
		 FOR UPDATE`, row.ID, row.Updated).Scan(&id)
	if err == pgx.ErrNoRows {
		return false, tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}
	if row.Held > 0 {
		if release == nil {
			return false, errReleaseNotWired
		}
		if _, err := release(ctx, tx, row.OrgID, row.PublicID, &row.ID, row.Held, "stranded_request"); err != nil {
			return false, err
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE ai_requests
		   SET status = 'unbilled_unknown', error_class = 'stranded_request',
		       settled_at = clock_timestamp(), updated_at = clock_timestamp()
		 WHERE id = $1`, row.ID); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

// PruneBodies clears response_body on rows settled more than 7 days ago.
// The billing row stays. At most 100 batches of 5000. Each batch is its own
// transaction under podhub_maintenance, which may only blank response_body.
func PruneBodies(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	var total int64
	for range 100 {
		var n int64
		err := db.InTx(ctx, pool, db.Maintenance(), func(tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, `
				WITH due AS (
				    SELECT id FROM ai_requests
				     WHERE response_body IS NOT NULL
				       AND settled_at < clock_timestamp() - ($1 || ' days')::interval
				     ORDER BY id
				     LIMIT $2
				)
				UPDATE ai_requests SET response_body = NULL
				 WHERE id IN (SELECT id FROM due)`, "7", 5000)
			if err != nil {
				return err
			}
			n = tag.RowsAffected()
			return nil
		})
		if err != nil {
			return total, err
		}
		total += n
		if n == 0 {
			break
		}
	}
	return total, nil
}

// Silence unused constants if a caller wants the names.
var _ = []int{strandedAfterSeconds, responseRetentionDays, reaperBatch}
