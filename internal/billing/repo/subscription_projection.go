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

// Subscription stores renewal intent and caches the currently projected period.
// Paid periods determine access even before the background sweep runs.
type Subscription struct {
	OrgID        int64
	Status       string
	PlanKey      string
	TermStart    *time.Time
	TermEnd      *time.Time
	Stores       int
	Revision     int64
	Anchor       *time.Time
	Periods      []domain.Period
	CurrentStart *time.Time
	CurrentEnd   *time.Time
}

// Active reports whether the term is still running.
func (s Subscription) Active(now time.Time) bool {
	return s.Status == domain.StatusActive && s.TermEnd != nil && s.TermEnd.After(now)
}

// Snapshot converts the row into the pricing core's view.
func (s Subscription) Snapshot() domain.Snapshot {
	snap := domain.Snapshot{
		Status:  s.Status,
		PlanKey: s.PlanKey,
		Stores:  s.Stores,
	}
	snap.Periods = s.Periods
	if s.Anchor != nil {
		snap.Anchor = *s.Anchor
	}
	if s.TermEnd != nil {
		snap.TermEnd = *s.TermEnd
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

// Catalog loads the plan catalogue in one query so a projection cannot
// observe a half-updated catalogue.
func Catalog(ctx context.Context, tx pgx.Tx) (domain.Catalog, error) {
	rows, err := tx.Query(ctx, `
		SELECT key, sort_order, store_monthly_cents
		  FROM plans WHERE active AND key = ANY($1::text[])`,
		[]string{domain.PlanFree, domain.PlanLite, domain.PlanPro, domain.PlanMax})
	if err != nil {
		return domain.Catalog{}, err
	}
	defer rows.Close()
	cat := domain.Catalog{Plans: map[string]domain.PlanPrice{}}
	for rows.Next() {
		var p domain.PlanPrice
		if err := rows.Scan(&p.Key, &p.Rank, &p.StoreMonthlyCents); err != nil {
			return domain.Catalog{}, err
		}
		p.Paid = p.Key != domain.PlanFree
		cat.Plans[p.Key] = p
	}
	if err := rows.Err(); err != nil {
		return domain.Catalog{}, err
	}
	if _, ok := cat.Plans[domain.PlanFree]; !ok {
		return domain.Catalog{}, errors.New("free plan missing from catalogue")
	}
	return cat, nil
}

// LockSubscription locks the organization row, then the subscription row.
// The order matches the admin seat writer, so a projection
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
		       stores, revision, billing_anchor
		  FROM subscriptions WHERE org_id = $1 FOR UPDATE`, orgID).Scan(
		&s.OrgID, &s.Status, &s.PlanKey, &s.TermStart, &s.TermEnd,
		&s.Stores, &s.Revision, &s.Anchor)
	if errors.Is(err, pgx.ErrNoRows) {
		return Subscription{}, ErrNoSubscription
	}
	return s, err
}

// ProjectSubscription recomputes plan, store_limit and
// plan_expires_at from the subscription row and the catalogue, then reconciles
// members and stores. It runs inside the caller's transaction.
func ProjectSubscription(ctx context.Context, tx pgx.Tx, orgID int64, now time.Time) (Projection, error) {
	s, err := LockSubscription(ctx, tx, orgID)
	if err != nil {
		return Projection{}, err
	}
	if err := s.loadPeriods(ctx, tx, now); err != nil {
		return Projection{}, err
	}
	active := s.Active(now)
	var planKey string
	var seats, stores int64
	if err := tx.QueryRow(ctx, `SELECT plan_key,members,stores FROM public.subscription_capacity($1,$2)`, orgID, now).Scan(&planKey, &seats, &stores); err != nil {
		return Projection{}, err
	}
	var expires *time.Time
	if active {
		expires = s.TermEnd
	}
	if active {
		if _, err := tx.Exec(ctx, `UPDATE subscriptions SET plan_key=$2,stores=$3,term_start=$4,
   revision=revision+1,updated_at=$5 WHERE org_id=$1 AND (plan_key,stores,term_start) IS DISTINCT FROM ($2::text,$3::integer,$4::timestamptz)`,
			orgID, s.PlanKey, s.Stores, s.CurrentStart, now); err != nil {
			return Projection{}, err
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE organizations
		   SET plan = $1, store_limit = $2, plan_expires_at = $3,
		       quota_revision = quota_revision + 1, updated_at = clock_timestamp()
		 WHERE id = $4
		   AND (plan IS DISTINCT FROM $1 OR store_limit IS DISTINCT FROM $2
		        OR plan_expires_at IS DISTINCT FROM $3)`,
		planKey, stores, expires, orgID); err != nil {
		return Projection{}, err
	}
	if err := ReconcileSubscriptionCapacity(ctx, tx, orgID, seats, stores, now); err != nil {
		return Projection{}, err
	}
	return Projection{Plan: planKey, SeatLimit: seats, StoreLimit: stores, ExpiresAt: expires, Revision: s.Revision}, nil
}

// ReconcileSubscriptionCapacity updates display flags immediately. Already accepted
// work uses its intent; these flags never grant permission to enqueue new work.
func ReconcileSubscriptionCapacity(ctx context.Context, tx pgx.Tx, orgID, seats, stores int64, now time.Time) error {
	_, err := tx.Exec(ctx, `UPDATE organization_members m
 SET quota_suspended=NOT public.subscription_member_allowed($1,m.id,$2),updated_at=clock_timestamp()
 WHERE m.org_id=$1 AND NOT m.manual_disabled AND m.status='active'
 AND m.quota_suspended IS DISTINCT FROM NOT public.subscription_member_allowed($1,m.id,$2)`, orgID, now)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE organization_stores s
 SET quota_suspended=NOT public.subscription_store_allowed($1,s.uuid,$2),revision=revision+1,updated_at=clock_timestamp()
 WHERE s.org_id=$1 AND s.deleted_at_ms IS NULL AND NOT s.manual_disabled
 AND s.quota_suspended IS DISTINCT FROM NOT public.subscription_store_allowed($1,s.uuid,$2)`, orgID, now)
	return err
}

// ExpireDue flips up to batch workspaces whose term has ended and opens a
// drain event for each. It crosses tenants, so it runs as the lookup role.
// Returns how many it expired.
func ExpireDue(ctx context.Context, pool *pgxpool.Pool, batch int, now time.Time) (int, error) {
	var ids []int64
	err := db.InTx(ctx, pool, db.AppRole(), func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT org_id FROM public.billing_due_subscriptions($1,$2)`, now, batch)
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
		if _, err := LockSubscription(ctx, tx, orgID); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			UPDATE subscriptions
			   SET status = 'expired', revision = revision + 1, updated_at = clock_timestamp()
			 WHERE org_id = $1 AND status = 'active' AND term_end <= $2`, orgID, now)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			_, err = ProjectSubscription(ctx, tx, orgID, now)
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
		if _, err := tx.Exec(ctx, `
			INSERT INTO notifications (uuid, user_id, kind, payload, created_at)
			SELECT gen_random_uuid(), o.owner_user_id, 'subscription_frozen',
			       jsonb_build_object('workspaceId', o.uuid::text, 'workspaceName', o.name),
			       clock_timestamp()
			  FROM organizations o WHERE o.id = $1`, orgID); err != nil {
			return err
		}
		_, err = ProjectSubscription(ctx, tx, orgID, now)
		return err
	})
}
