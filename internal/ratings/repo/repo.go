package ratingsrepo

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/ratings/contract"
	"github.com/xxww0098/podhub-go/internal/ratings/domain"
)

// Repo reads and writes rating rows. Snapshot and history statements for
// one org run inside an app session. Claim and prune are cross-tenant, so
// they use the worker session. The list and history statements do not take
// row locks. Locking stays in the statement text.
type Repo struct {
	pool *pgxpool.Pool
}

// New binds a pool.
func New(pool *pgxpool.Pool) *Repo {
	return &Repo{pool: pool}
}

const listSQL = `
SELECT s.rating_key, s.name, s.value_type, s.status,
       s.current_value::text, s.past_value::text, s.synced_at,
       prev.current_value::text
  FROM store_rating_snapshots s
  LEFT JOIN LATERAL (
        SELECT h.current_value
          FROM store_rating_history h
         WHERE h.org_id = s.org_id AND h.store_id = s.store_id AND h.rating_key = s.rating_key
         ORDER BY h.id DESC
         OFFSET 1
         LIMIT 1
  ) prev ON true
 WHERE s.org_id = $1 AND s.store_id = $2::uuid
 ORDER BY s.rating_key`

// ListSQL is the read statement. It has no FOR UPDATE.
func ListSQL() string { return listSQL }

// Gate loads the store and the caller's membership under the app role.
func (r *Repo) Gate(ctx context.Context, orgID, userID int64, storeID string) (domain.Gate, error) {
	var g domain.Gate
	err := r.inApp(ctx, orgID, func(tx pgx.Tx) error {
		var member *int64
		var role *string
		err := tx.QueryRow(ctx, `
		SELECT s.assignee_membership_id, m.id, m.role
		  FROM organization_stores s
		  LEFT JOIN organization_members m
		    ON m.org_id = s.org_id AND m.user_id = $3
		   AND m.status = 'active' AND NOT m.manual_disabled AND NOT m.quota_suspended
		 WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.deleted_at_ms IS NULL
		 LIMIT 1`, orgID, storeID, userID).Scan(&g.Assignee, &member, &role)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.ErrNotFound
		}
		if err != nil {
			return err
		}
		if member != nil {
			g.MemberID = *member
		}
		if role != nil {
			g.Role = *role
		}
		return nil
	})
	if err != nil {
		return domain.Gate{}, err
	}
	return g, nil
}

// Apply upserts snapshots and appends history only when status or
// current_value changed. A worsened mapped status inserts one bell row.
func (r *Repo) Apply(ctx context.Context, orgID int64, storeID string, items []domain.Rating, now time.Time, ranks map[string]int) (domain.ApplyResult, error) {
	var out domain.ApplyResult
	err := r.inApp(ctx, orgID, func(tx pgx.Tx) error {
		var userID *int64
		for _, item := range items {
			existed, oldStatus, oldCur, err := lockSnapshot(ctx, tx, orgID, storeID, item.Key)
			if err != nil {
				return err
			}
			changed := domain.Changed(existed, oldStatus, item.Status, oldCur, item.Current)
			if err := upsertSnapshot(ctx, tx, orgID, storeID, item, now); err != nil {
				return err
			}
			if !changed {
				continue
			}
			if err := insertHistory(ctx, tx, orgID, storeID, item, now); err != nil {
				return err
			}
			out.History++
			if !domain.Worsened(ranks, existed, oldStatus, item.Status) {
				continue
			}
			if userID == nil {
				id, err := notifyUser(ctx, tx, orgID, storeID)
				if err != nil {
					return err
				}
				userID = &id
			}
			if *userID == 0 {
				continue
			}
			if err := insertNote(ctx, tx, *userID, storeID, item.Key, oldStatus, item.Status); err != nil {
				return err
			}
			out.Noted++
		}
		return nil
	})
	if err != nil {
		return domain.ApplyResult{}, err
	}
	return out, nil
}

func lockSnapshot(ctx context.Context, tx pgx.Tx, orgID int64, storeID, key string) (bool, string, *string, error) {
	var status string
	var current *string
	err := tx.QueryRow(ctx, `
		SELECT status, current_value::text
		  FROM store_rating_snapshots
		 WHERE org_id = $1 AND store_id = $2::uuid AND rating_key = $3
		 FOR UPDATE`, orgID, storeID, key).Scan(&status, &current)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, "", nil, nil
	}
	if err != nil {
		return false, "", nil, err
	}
	return true, status, current, nil
}

func upsertSnapshot(ctx context.Context, tx pgx.Tx, orgID int64, storeID string, item domain.Rating, now time.Time) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO store_rating_snapshots
		    (org_id, store_id, rating_key, name, value_type, status, current_value, past_value, synced_at)
		VALUES ($1, $2::uuid, $3, $4, $5, $6, NULLIF($7, '')::numeric, NULLIF($8, '')::numeric, $9)
		ON CONFLICT (org_id, store_id, rating_key) DO UPDATE SET
		    name = EXCLUDED.name,
		    value_type = EXCLUDED.value_type,
		    status = EXCLUDED.status,
		    current_value = EXCLUDED.current_value,
		    past_value = EXCLUDED.past_value,
		    synced_at = EXCLUDED.synced_at`,
		orgID, storeID, item.Key, item.Name, item.ValueType, item.Status, text(item.Current), text(item.Past), now)
	return err
}

func insertHistory(ctx context.Context, tx pgx.Tx, orgID int64, storeID string, item domain.Rating, now time.Time) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO store_rating_history
		    (org_id, store_id, rating_key, name, value_type, status, current_value, past_value, recorded_at)
		VALUES ($1, $2::uuid, $3, $4, $5, $6, NULLIF($7, '')::numeric, NULLIF($8, '')::numeric, $9)`,
		orgID, storeID, item.Key, item.Name, item.ValueType, item.Status, text(item.Current), text(item.Past), now)
	return err
}

func notifyUser(ctx context.Context, tx pgx.Tx, orgID int64, storeID string) (int64, error) {
	var id *int64
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(
		    (SELECT m.user_id FROM organization_stores s
		      JOIN organization_members m ON m.id = s.assignee_membership_id
		      WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.assignee_membership_id IS NOT NULL),
		    (SELECT owner_user_id FROM organizations WHERE id = $1))`, orgID, storeID).Scan(&id)
	if err != nil || id == nil {
		return 0, err
	}
	return *id, nil
}

func insertNote(ctx context.Context, tx pgx.Tx, userID int64, storeID, key, from, to string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO notifications (uuid, user_id, kind, payload, created_at)
		VALUES (gen_random_uuid(), $1, $2, jsonb_build_object(
		    'storeId', $3::text,
		    'ratingKey', $4::text,
		    'fromStatus', $5::text,
		    'toStatus', $6::text
		), clock_timestamp())`, userID, contract.KindWorsened, storeID, key, from, to)
	return err
}

func text(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// List reads snapshots for one org. It does not lock the rows.
func (r *Repo) List(ctx context.Context, orgID int64, storeID string) ([]domain.Snapshot, error) {
	var out []domain.Snapshot
	err := r.inApp(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, listSQL, orgID, storeID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row domain.Snapshot
			if err := rows.Scan(&row.Key, &row.Name, &row.ValueType, &row.Status, &row.Current, &row.Past, &row.SyncedAt, &row.Previous); err != nil {
				return err
			}
			out = append(out, row)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// History reads one page, newest id first. cursor 0 is the first page.
func (r *Repo) History(ctx context.Context, orgID int64, storeID, ratingKey string, cursor int64, limit int) ([]domain.HistoryRow, error) {
	var out []domain.HistoryRow
	err := r.inApp(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
		SELECT id, rating_key, name, value_type, status,
		       current_value::text, past_value::text, recorded_at
		  FROM store_rating_history
		 WHERE org_id = $1 AND store_id = $2::uuid
		   AND ($3 = '' OR rating_key = $3)
		   AND ($4 = 0 OR id < $4)
		 ORDER BY id DESC
		 LIMIT $5`, orgID, storeID, ratingKey, cursor, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row domain.HistoryRow
			if err := rows.Scan(&row.ID, &row.Key, &row.Name, &row.ValueType, &row.Status, &row.Current, &row.Past, &row.At); err != nil {
				return err
			}
			out = append(out, row)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) inApp(ctx context.Context, orgID int64, fn func(pgx.Tx) error) error {
	if r == nil || r.pool == nil || orgID <= 0 {
		return contract.ErrUnavailable
	}
	return db.InTx(ctx, r.pool, db.App(orgID), fn)
}

func (r *Repo) inWorker(ctx context.Context, fn func(pgx.Tx) error) error {
	if r == nil || r.pool == nil {
		return contract.ErrUnavailable
	}
	return db.InTx(ctx, r.pool, db.Worker(), fn)
}

// ClaimDue leases stores whose id modulo the slot count matches this tick
// and whose last success is older than interval. organization_stores is
// not locked. The lease is a timestamp committed before the HTTP call.
func (r *Repo) ClaimDue(ctx context.Context, now time.Time, interval time.Duration, slots, bucket, limit int) ([]domain.Due, error) {
	if r == nil || r.pool == nil {
		return nil, contract.ErrUnavailable
	}
	if slots < 1 {
		slots = 1
	}
	if limit < 1 {
		limit = 1
	}
	secs := int64(interval / time.Second)
	if secs < 1 {
		secs = 1
	}
	var out []domain.Due
	err := r.inWorker(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
		WITH picked AS (
		    SELECT s.org_id, s.uuid
		      FROM organization_stores s
		      LEFT JOIN store_rating_sync y
		        ON y.org_id = s.org_id AND y.store_id = s.uuid
		     WHERE s.deleted_at_ms IS NULL
		       AND (y.lease_until IS NULL OR y.lease_until <= $1)
		       AND (y.synced_at IS NULL OR y.synced_at <= $1 - make_interval(secs => $2::int))
		       AND MOD(s.id, $3::bigint) = $4::bigint
		     ORDER BY s.id
		     LIMIT $5
		)
		INSERT INTO store_rating_sync (org_id, store_id, lease_until)
		SELECT org_id, uuid, $1 + interval '90 seconds' FROM picked
		ON CONFLICT (org_id, store_id) DO UPDATE
		    SET lease_until = EXCLUDED.lease_until
		  WHERE store_rating_sync.lease_until IS NULL
		     OR store_rating_sync.lease_until <= $1
		RETURNING org_id, store_id::text`, now, secs, slots, bucket, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row domain.Due
			if err := rows.Scan(&row.OrgID, &row.StoreID); err != nil {
				return err
			}
			out = append(out, row)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Finish clears the lease. A success also records synced_at.
func (r *Repo) Finish(ctx context.Context, orgID int64, storeID string, now time.Time, ok bool) error {
	var tag string
	if ok {
		tag = `synced_at = $3,`
	}
	return r.inApp(ctx, orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
		UPDATE store_rating_sync
		   SET `+tag+`
		       lease_until = $3
		 WHERE org_id = $1 AND store_id = $2::uuid`, orgID, storeID, now)
		return err
	})
}

// Prune deletes history rows older than cutoff across orgs. The worker
// role is the cross-tenant claim. Snapshots are left in place.
func (r *Repo) Prune(ctx context.Context, cutoff time.Time) (int64, error) {
	var n int64
	err := r.inWorker(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM store_rating_history WHERE recorded_at < $1`, cutoff)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
		return nil
	})
	if err != nil {
		return 0, err
	}
	return n, nil
}

// CountHistory is a test helper under the app role.
func (r *Repo) CountHistory(ctx context.Context, orgID int64, storeID string) (int, error) {
	var n int
	err := r.inApp(ctx, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
		SELECT count(*) FROM store_rating_history
		 WHERE org_id = $1 AND store_id = $2::uuid`, orgID, storeID).Scan(&n)
	})
	if err != nil {
		return 0, err
	}
	return n, nil
}

// MissingGUC fails closed: the app role without the tenant setting cannot
// see or insert rating rows.
func MissingGUC(ctx context.Context, pool *pgxpool.Pool, orgID int64, storeID string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', $1, true)`, tenantx.RoleApp); err != nil {
		return err
	}
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM store_rating_snapshots`).Scan(&n); err != nil {
		return err
	}
	if n != 0 {
		return fmt.Errorf("missing guc saw %d snapshots", n)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM store_rating_history`).Scan(&n); err != nil {
		return err
	}
	if n != 0 {
		return fmt.Errorf("missing guc saw %d history", n)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO store_rating_snapshots
		    (org_id, store_id, rating_key, name, value_type, status, synced_at)
		VALUES ($1, $2::uuid, 'rating_x', '', '', 'UNKNOWN', clock_timestamp())`, orgID, storeID)
	if err == nil {
		return errors.New("missing guc inserted a snapshot")
	}
	return nil
}
