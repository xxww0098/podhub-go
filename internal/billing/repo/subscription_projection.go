package billingrepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/billing/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

// Subscription is the stored term. status is written by the expiration sweep;
// readers trust the column rather than comparing term_end themselves.
type Subscription struct {
	OrgID        int64
	Status       string
	PlanKey      string
	TermStart    *time.Time
	TermEnd      *time.Time
	ExtraStores  int
	ExtraMembers int
	NextPlanKey  *string
	NextStores   int
	NextMembers  int
	Revision     int64
}

// Active reports whether the term is still running.
func (s Subscription) Active(now time.Time) bool {
	return s.Status == domain.StatusActive && s.TermEnd != nil && s.TermEnd.After(now)
}

// Snapshot converts the row into the pricing core's view.
func (s Subscription) Snapshot() domain.Snapshot {
	snap := domain.Snapshot{
		Status:           s.Status,
		PlanKey:          s.PlanKey,
		ExtraStores:      s.ExtraStores,
		ExtraMembers:     s.ExtraMembers,
		NextExtraStores:  s.NextStores,
		NextExtraMembers: s.NextMembers,
	}
	if s.TermEnd != nil {
		snap.TermEnd = *s.TermEnd
	}
	if s.NextPlanKey != nil {
		snap.NextPlanKey = *s.NextPlanKey
	}
	return snap
}

// Projection is what ProjectSubscription wrote to organizations.
type Projection struct {
	Plan       string
	SeatLimit  int64
	StoreLimit int64
	ExpiresAt  *time.Time
	Revision   int64
}

// ErrNoSubscription means the workspace has no row. Registration and the
// backfill both create one; a missing row is a bug, not a state to handle.
var ErrNoSubscription = errors.New("subscription row missing")

// Catalog loads the plan catalogue and the add-on prices in one query so a
// projection cannot observe a half-updated catalogue.
func Catalog(ctx context.Context, tx pgx.Tx) (domain.Catalog, error) {
	var storeCents, memberCents int64
	if err := tx.QueryRow(ctx, `
		SELECT store_monthly_cents, member_monthly_cents
		  FROM billing_settings WHERE id`).Scan(&storeCents, &memberCents); err != nil {
		return domain.Catalog{}, err
	}
	var rows [4]struct {
		price   int64
		stores  int64
		members int64
	}
	vals := make([]any, 0, 12)
	for i := range rows {
		vals = append(vals, &rows[i].price, &rows[i].stores, &rows[i].members)
	}
	if err := tx.QueryRow(ctx, `
		SELECT
		    max(price_monthly_cents) FILTER (WHERE key = 'free'),
		    max(max_stores)          FILTER (WHERE key = 'free'),
		    max(seat_limit)          FILTER (WHERE key = 'free'),
		    max(price_monthly_cents) FILTER (WHERE key = 'lite'),
		    max(max_stores)          FILTER (WHERE key = 'lite'),
		    max(seat_limit)          FILTER (WHERE key = 'lite'),
		    max(price_monthly_cents) FILTER (WHERE key = 'pro'),
		    max(max_stores)          FILTER (WHERE key = 'pro'),
		    max(seat_limit)          FILTER (WHERE key = 'pro'),
		    max(price_monthly_cents) FILTER (WHERE key = 'max'),
		    max(max_stores)          FILTER (WHERE key = 'max'),
		    max(seat_limit)          FILTER (WHERE key = 'max')
		  FROM plans`).Scan(vals...); err != nil {
		return domain.Catalog{}, err
	}
	keys := []string{domain.PlanFree, domain.PlanLite, domain.PlanPro, domain.PlanMax}
	cat := domain.Catalog{
		Plans:              map[string]domain.PlanPrice{},
		StoreMonthlyCents:  storeCents,
		MemberMonthlyCents: memberCents,
	}
	for i, key := range keys {
		cat.Plans[key] = domain.PlanPrice{
			Key:          key,
			MonthlyCents: rows[i].price,
			Stores:       int(rows[i].stores),
			Members:      int(rows[i].members),
			Addons:       key != domain.PlanFree,
		}
	}
	if _, ok := cat.Plans[domain.PlanFree]; !ok {
		return domain.Catalog{}, errors.New("free plan missing from catalogue")
	}
	return cat, nil
}

// LockSubscription locks the organization row, then the subscription row.
// The order matches ApplySeats and the admin seat writers, so a projection
// and an admin change serialize instead of deadlocking.
func LockSubscription(ctx context.Context, tx pgx.Tx, orgID int64) (Subscription, error) {
	var locked int64
	if err := tx.QueryRow(ctx,
		`SELECT id FROM organizations WHERE id = $1 FOR UPDATE`, orgID).Scan(&locked); err != nil {
		return Subscription{}, err
	}
	var s Subscription
	err := tx.QueryRow(ctx, `
		SELECT org_id, status, plan_key, term_start, term_end,
		       extra_stores, extra_members, next_plan_key,
		       next_extra_stores, next_extra_members, revision
		  FROM subscriptions WHERE org_id = $1 FOR UPDATE`, orgID).Scan(
		&s.OrgID, &s.Status, &s.PlanKey, &s.TermStart, &s.TermEnd,
		&s.ExtraStores, &s.ExtraMembers, &s.NextPlanKey,
		&s.NextStores, &s.NextMembers, &s.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return Subscription{}, ErrNoSubscription
	}
	return s, err
}

// ProjectSubscription recomputes plan, seat_limit, store_limit and
// plan_expires_at from the subscription row and the catalogue, then reconciles
// members and stores. It runs inside the caller's transaction.
func ProjectSubscription(ctx context.Context, tx pgx.Tx, orgID int64, now time.Time) (Projection, error) {
	s, err := LockSubscription(ctx, tx, orgID)
	if err != nil {
		return Projection{}, err
	}
	cat, err := Catalog(ctx, tx)
	if err != nil {
		return Projection{}, err
	}
	active := s.Active(now)
	planKey := domain.PlanFree
	if active {
		planKey = s.PlanKey
	}
	plan, ok := cat.Plans[planKey]
	if !ok {
		return Projection{}, errors.New("plan missing from catalogue: " + planKey)
	}
	seats := int64(plan.Members)
	stores := int64(plan.Stores)
	var expires *time.Time
	if active {
		seats += int64(s.ExtraMembers)
		stores += int64(s.ExtraStores)
		expires = s.TermEnd
	}
	if _, err := tx.Exec(ctx, `
		UPDATE organizations
		   SET plan = $1, seat_limit = $2, store_limit = $3, plan_expires_at = $4,
		       quota_revision = quota_revision + 1, updated_at = clock_timestamp()
		 WHERE id = $5
		   AND (plan IS DISTINCT FROM $1 OR seat_limit IS DISTINCT FROM $2
		        OR store_limit IS DISTINCT FROM $3 OR plan_expires_at IS DISTINCT FROM $4)`,
		planKey, seats, stores, expires, orgID); err != nil {
		return Projection{}, err
	}
	if err := ReconcileSubscriptionCapacity(ctx, tx, orgID, seats, stores, now); err != nil {
		return Projection{}, err
	}
	return Projection{Plan: planKey, SeatLimit: seats, StoreLimit: stores, ExpiresAt: expires, Revision: s.Revision}, nil
}

// ReconcileSubscriptionCapacity suspends members and stores beyond the
// projection. A member or store that still owns a live drain job is not
// suspended: work queued before expiry is allowed to finish.
func ReconcileSubscriptionCapacity(ctx context.Context, tx pgx.Tx, orgID, seats, stores int64, now time.Time) error {
	drainStart, err := DrainStart(ctx, tx, orgID)
	if err != nil {
		return err
	}
	if seats < 1 {
		seats = 1
	}
	if stores < 1 {
		stores = 1
	}
	if _, err := tx.Exec(ctx, `
		WITH ranked AS (
		    SELECT m.id,
		           row_number() OVER (
		               ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END,
		                        m.join_order ASC, m.id ASC) AS rn
		      FROM organization_members m
		     WHERE m.org_id = $1 AND NOT m.manual_disabled AND m.role <> 'owner'
		),
		blocked AS (
		    SELECT DISTINCT j.member_id
		      FROM jobs j
		     WHERE j.org_id = $1 AND j.member_id IS NOT NULL
		       AND $3::timestamptz IS NOT NULL
		       AND j.created_at < $3::timestamptz
		       AND j.kind NOT IN ('media.render', 'media.upload')
		       AND j.cancel_requested_at IS NULL
		       AND (j.state IN ('queued', 'retry_wait')
		            OR (j.state = 'running' AND j.lease_until > $2))
		)
		UPDATE organization_members m
		   SET quota_suspended = (r.rn > $4 AND b.member_id IS NULL),
		       updated_at = clock_timestamp()
		  FROM ranked r
		  LEFT JOIN blocked b ON b.member_id = r.id
		 WHERE m.id = r.id
		   AND m.quota_suspended IS DISTINCT FROM (r.rn > $4 AND b.member_id IS NULL)`,
		orgID, now, drainStart, seats); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		WITH ranked AS (
		    SELECT s.id,
		           row_number() OVER (ORDER BY s.create_order ASC, s.id ASC) AS rn
		      FROM organization_stores s
		     WHERE s.org_id = $1 AND s.deleted_at_ms IS NULL AND NOT s.manual_disabled
		),
		blocked AS (
		    SELECT DISTINCT j.store_id
		      FROM jobs j
		     WHERE j.org_id = $1 AND j.store_id IS NOT NULL
		       AND $3::timestamptz IS NOT NULL
		       AND j.created_at < $3::timestamptz
		       AND j.kind NOT IN ('media.render', 'media.upload')
		       AND j.cancel_requested_at IS NULL
		       AND (j.state IN ('queued', 'retry_wait')
		            OR (j.state = 'running' AND j.lease_until > $2))
		)
		UPDATE organization_stores s
		   SET quota_suspended = (r.rn > $4 AND b.store_id IS NULL),
		       revision = revision + 1,
		       updated_at = clock_timestamp()
		  FROM ranked r
		  LEFT JOIN blocked b ON b.store_id = r.id
		 WHERE s.id = r.id
		   AND s.quota_suspended IS DISTINCT FROM (r.rn > $4 AND b.store_id IS NULL)`,
		orgID, now, drainStart, stores)
	return err
}

// DrainStart returns effective_at of the newest drain event with no matching
// drain_done, or nil when the workspace is not draining.
func DrainStart(ctx context.Context, tx pgx.Tx, orgID int64) (*time.Time, error) {
	var start *time.Time
	err := tx.QueryRow(ctx, `
		SELECT e.effective_at
		  FROM subscription_events e
		 WHERE e.org_id = $1 AND e.kind = 'drain'
		   AND NOT EXISTS (
		       SELECT 1 FROM subscription_events d
		        WHERE d.org_id = e.org_id AND d.kind = 'drain_done'
		          AND (d.breakdown->>'drain_event_id')::bigint = e.id)
		 ORDER BY e.id DESC
		 LIMIT 1`, orgID).Scan(&start)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return start, err
}

// ExpireDue flips up to batch workspaces whose term has ended and opens a
// drain event for each. It crosses tenants, so it runs as the lookup role.
// Returns how many it expired.
func ExpireDue(ctx context.Context, pool *pgxpool.Pool, batch int, now time.Time) (int, error) {
	var ids []int64
	err := db.InTx(ctx, pool, db.AppRole(), func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT set_config('role', 'podhub_billing_lookup', true)"); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			SELECT org_id FROM subscriptions
			 WHERE status = 'active' AND term_end <= $1
			 ORDER BY term_end LIMIT $2`, now, batch)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				return err
			}
			ids = append(ids, id)
		}
		return rows.Err()
	})
	if err != nil {
		return 0, err
	}
	var done int
	for _, id := range ids {
		if err := expireOne(ctx, pool, id, now); err != nil {
			continue
		}
		done++
	}
	return done, nil
}

// expireOne is one workspace: mark expired, open the drain event, then
// reproject under the app role so the new tables' RLS applies.
func expireOne(ctx context.Context, pool *pgxpool.Pool, orgID int64, now time.Time) error {
	return db.InTx(ctx, pool, db.App(orgID), func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE subscriptions
			   SET status = 'expired', revision = revision + 1, updated_at = clock_timestamp()
			 WHERE org_id = $1 AND status = 'active' AND term_end <= $2`, orgID, now)
		if err != nil || tag.RowsAffected() != 1 {
			return err
		}
		// Counts only: the drain range is recomputed from effective_at, so a
		// list of ids would be stale the moment the first job finishes.
		if _, err := tx.Exec(ctx, `
			INSERT INTO subscription_events
			    (org_id, kind, effective_at, breakdown, created_at)
			SELECT $1, 'drain', term_end,
			       jsonb_build_object(
			           'queued', (SELECT count(*) FROM jobs j
			                       WHERE j.org_id = $1 AND j.created_at < s.term_end
			                         AND j.state IN ('queued', 'retry_wait')
			                         AND j.cancel_requested_at IS NULL
			                         AND j.kind NOT IN ('media.render', 'media.upload')),
			           'running', (SELECT count(*) FROM jobs j
			                        WHERE j.org_id = $1 AND j.created_at < s.term_end
			                          AND j.state = 'running' AND j.lease_until > clock_timestamp()
			                          AND j.cancel_requested_at IS NULL
			                          AND j.kind NOT IN ('media.render', 'media.upload'))),
			       clock_timestamp()
			  FROM subscriptions s
			 WHERE s.org_id = $1 AND s.status = 'expired'`, orgID); err != nil {
			return err
		}
		_, err = ProjectSubscription(ctx, tx, orgID, now)
		return err
	})
}
