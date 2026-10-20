package billingrepo

import (
	"context"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// SeatProjection is the plan written onto the organization.
type SeatProjection struct {
	Plan           string
	EffectiveSeats int64
	ExpiresAt      *time.Time
	Applied        bool
}

func tierKey(rank int) string {
	switch rank {
	case 3:
		return "ultra"
	case 2:
		return "max"
	case 1:
		return "pro"
	default:
		return "lite"
	}
}

func tierRank(tier string) int {
	switch tier {
	case "ultra":
		return 3
	case "max":
		return 2
	case "pro":
		return 1
	default:
		return 0
	}
}

// ProjectOrgSeatState writes plan, seat_limit, and plan_expires_at when they differ.
// effective seats are the override when set, otherwise max(purchased, 1).
func ProjectOrgSeatState(ctx context.Context, tx pgx.Tx, orgID int64) (SeatProjection, error) {
	var override *int64
	if err := tx.QueryRow(ctx, `SELECT member_seat_limit_override FROM organizations WHERE id = $1`, orgID).Scan(&override); err != nil {
		return SeatProjection{}, err
	}
	rows, err := tx.Query(ctx, `
		WITH clock AS (SELECT clock_timestamp() AS now)
		SELECT tier, COALESCE(SUM(seats), 0)::bigint AS seats
		  FROM member_seat_lots
		 CROSS JOIN clock
		 WHERE org_id = $1
		   AND starts_at <= clock.now
		   AND expires_at > clock.now
		 GROUP BY tier`, orgID)
	if err != nil {
		return SeatProjection{}, err
	}
	rank := 0
	var purchased int64
	for rows.Next() {
		var tier string
		var seats int64
		if err := rows.Scan(&tier, &seats); err != nil {
			rows.Close()
			return SeatProjection{}, err
		}
		purchased += seats
		if tierRank(tier) > rank {
			rank = tierRank(tier)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return SeatProjection{}, err
	}
	var expires *time.Time
	if err := tx.QueryRow(ctx, `
		WITH clock AS (SELECT clock_timestamp() AS now)
		SELECT MAX(expires_at)
		  FROM member_seat_lots
		 CROSS JOIN clock
		 WHERE org_id = $1 AND expires_at > clock.now`, orgID).Scan(&expires); err != nil {
		return SeatProjection{}, err
	}
	effective := purchased
	if effective < 1 {
		effective = 1
	}
	if override != nil {
		effective = *override
	}
	plan := tierKey(rank)
	tag, err := tx.Exec(ctx, `
		UPDATE organizations
		   SET plan = $1,
		       seat_limit = $2,
		       plan_expires_at = $3,
		       quota_revision = quota_revision + 1,
		       updated_at = clock_timestamp()
		 WHERE id = $4
		   AND (plan IS DISTINCT FROM $1
		        OR seat_limit IS DISTINCT FROM $2
		        OR plan_expires_at IS DISTINCT FROM $3)`, plan, effective, expires, orgID)
	if err != nil {
		return SeatProjection{}, err
	}
	return SeatProjection{Plan: plan, EffectiveSeats: effective, ExpiresAt: expires, Applied: tag.RowsAffected() == 1}, nil
}

type memberRow struct {
	ID             int64
	UserID         int64
	Role           string
	ManualDisabled bool
	QuotaSuspended bool
}

// ReconcileSeats keeps the owner active, skips manual_disabled, and fills the rest by join order.
// Newly suspended members lose account_sessions. Store-quota reconcile is not implemented.
func ReconcileSeats(ctx context.Context, tx pgx.Tx, orgID, seatLimit int64) error {
	if seatLimit < 1 {
		seatLimit = 1
	}
	rows, err := tx.Query(ctx, `
		SELECT id, user_id, role, manual_disabled, quota_suspended
		  FROM organization_members
		 WHERE org_id = $1
		 ORDER BY join_order ASC, id ASC`, orgID)
	if err != nil {
		return err
	}
	var members []memberRow
	for rows.Next() {
		var row memberRow
		if err := rows.Scan(&row.ID, &row.UserID, &row.Role, &row.ManualDisabled, &row.QuotaSuspended); err != nil {
			rows.Close()
			return err
		}
		members = append(members, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	var used int64
	var suspend, restore, sessions []int64
	for _, member := range members {
		if member.Role == "owner" {
			used++
			if member.QuotaSuspended {
				restore = append(restore, member.ID)
			}
			continue
		}
		if member.ManualDisabled {
			continue
		}
		if used < seatLimit {
			used++
			if member.QuotaSuspended {
				restore = append(restore, member.ID)
			}
			continue
		}
		if !member.QuotaSuspended {
			suspend = append(suspend, member.ID)
			sessions = append(sessions, member.UserID)
		}
	}
	if len(suspend) > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE organization_members
			   SET quota_suspended = true, updated_at = clock_timestamp()
			 WHERE id = ANY($1::bigint[]) AND role <> 'owner'`, suspend); err != nil {
			return err
		}
	}
	if len(restore) > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE organization_members
			   SET quota_suspended = false, updated_at = clock_timestamp()
			 WHERE id = ANY($1::bigint[])`, restore); err != nil {
			return err
		}
	}
	if len(sessions) > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM account_sessions WHERE user_id = ANY($1::bigint[])`, sessions); err != nil {
			return err
		}
	}
	return nil
}

// SweepEntitlements reprojects organizations whose seat lots no longer match the row.
// Batch size is 200. Each org then reconciles member seats and store quota.
// Returns how many orgs were locked.
func SweepEntitlements(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	rows, err := tx.Query(ctx, `
		WITH clock AS (SELECT clock_timestamp() AS now),
		     live AS (
		         SELECT l.org_id,
		                SUM(l.seats)::bigint AS seats,
		                MAX(l.expires_at) AS expires_at,
		                MAX(CASE l.tier WHEN 'ultra' THEN 3 WHEN 'max' THEN 2
		                                WHEN 'pro' THEN 1 ELSE 0 END) AS tier_rank
		           FROM member_seat_lots l, clock
		          WHERE l.starts_at <= clock.now AND l.expires_at > clock.now
		          GROUP BY l.org_id
		     )
		SELECT o.id
		  FROM organizations o
		 WHERE o.dissolved_at IS NULL
		   AND EXISTS (
		           SELECT 1 FROM member_seat_lots e, clock
		            WHERE e.org_id = o.id AND e.expires_at <= clock.now)
		   AND (
		           o.plan IS DISTINCT FROM COALESCE(
		               (SELECT CASE v.tier_rank WHEN 3 THEN 'ultra'
		                       WHEN 2 THEN 'max' WHEN 1 THEN 'pro'
		                       ELSE 'lite' END
		                  FROM live v WHERE v.org_id = o.id), 'lite')
		        OR o.seat_limit IS DISTINCT FROM COALESCE(
		               o.member_seat_limit_override,
		               GREATEST(COALESCE(
		                   (SELECT v.seats FROM live v WHERE v.org_id = o.id), 0), 1))
		        OR o.plan_expires_at IS DISTINCT FROM (
		               SELECT MAX(e2.expires_at)
		                 FROM member_seat_lots e2, clock
		                WHERE e2.org_id = o.id
		                  AND e2.expires_at > clock.now)
		   )
		 ORDER BY o.id
		 LIMIT 200`)
	if err != nil {
		tx.Rollback(ctx)
		return 0, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			tx.Rollback(ctx)
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		tx.Rollback(ctx)
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	var done int
	for _, id := range ids {
		if err := projectOne(ctx, pool, id); err != nil {
			continue
		}
		done++
	}
	return done, nil
}

func projectOne(ctx context.Context, pool *pgxpool.Pool, orgID int64) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// One org at a time. Entering the app role also sets app.current_org_id,
	// which organizations does not use but member_seat_lots' tenant policy does.
	if _, err := tx.Exec(ctx, "SELECT set_config('role', $1, true)", tenantx.RoleApp); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		"SELECT set_config($1, $2, true)",
		tenantx.GUCCurrentOrgID, strconv.FormatInt(orgID, 10)); err != nil {
		return err
	}
	var locked int64
	err = tx.QueryRow(ctx, `SELECT id FROM organizations WHERE id = $1 AND dissolved_at IS NULL FOR UPDATE`, orgID).Scan(&locked)
	if err != nil {
		return err
	}
	projection, err := ProjectOrgSeatState(ctx, tx, orgID)
	if err != nil {
		return err
	}
	if err := ReconcileSeats(ctx, tx, orgID, projection.EffectiveSeats); err != nil {
		return err
	}
	if err := ReconcileStores(ctx, tx, orgID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
