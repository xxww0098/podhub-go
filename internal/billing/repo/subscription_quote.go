package billingrepo

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

// QuoteTTL is how long a quoted price is honored. The payment window is
// shorter than this, so a user who reaches the payment page never has the
// quote expire under them.
const QuoteTTL = 15 * time.Minute

// QuoteRequest is contract.QuoteRequest. The alias keeps the repo signatures
// short while both packages agree on one type.
type QuoteRequest = contract.QuoteRequest

// Offered is contract.Offered.
type Offered = contract.Offered

// QuoteCurrent is contract.QuoteCurrent.
type QuoteCurrent = contract.QuoteCurrent

// QuoteTargetOut is contract.QuoteTargetOut.
type QuoteTargetOut = contract.QuoteTargetOut

type quoteRow struct {
	Revision     int64         `json:"revision"`
	Action       string        `json:"action"`
	Months       int           `json:"months"`
	TermStart    *time.Time    `json:"term_start"`
	TermEnd      *time.Time    `json:"term_end"`
	PlanKey      string        `json:"plan_key"`
	ExtraStores  int           `json:"extra_stores"`
	ExtraMembers int           `json:"extra_members"`
	KeepStores   []string      `json:"keep_store_ids"`
	KeepMembers  []int64       `json:"keep_member_ids"`
	Amount       int64         `json:"amount_cents"`
	Breakdown    []domain.Line `json:"breakdown"`
	ScheduleOnly bool          `json:"schedule_only"`
}

// Quote prices one action against the live subscription and stores the
// result. A zero-amount reduction stores a schedule instead and returns
// ScheduleOnly, with no quote row: there is nothing to pay.
func Quote(ctx context.Context, pool *pgxpool.Pool, orgID int64, req QuoteRequest, now time.Time) (Offered, error) {
	var out Offered
	err := db.InTx(ctx, pool, db.App(orgID), func(tx pgx.Tx) error {
		sub, err := LockSubscription(ctx, tx, orgID)
		if err != nil {
			return err
		}
		cat, err := Catalog(ctx, tx)
		if err != nil {
			return err
		}
		liveStores, liveMembers, err := liveCapacity(ctx, tx, orgID)
		if err != nil {
			return err
		}
		q, err := domain.Quote(cat, domain.QuoteInput{
			Now:         now,
			Snapshot:    sub.Snapshot(),
			Action:      req.Action,
			Target:      domain.Target(req.Target),
			Months:      req.Months,
			KeepStores:  len(req.KeepStores),
			KeepMembers: len(req.KeepMembers),
			LiveStores:  liveStores,
			LiveMembers: liveMembers,
		})
		if err != nil {
			return err
		}
		if q.ScheduleOnly {
			if err := writeSchedule(ctx, tx, orgID, cat, q, req, now); err != nil {
				return err
			}
			out = Offered{
				Revision:     sub.Revision + 1,
				Action:       q.Action,
				Current:      QuoteCurrent{PlanKey: sub.PlanKey, Stores: liveStores, Members: liveMembers, TermEnd: sub.TermEnd},
				Target:       QuoteTargetOut{PlanKey: q.PlanKey, Stores: q.Stores(), Members: q.Members()},
				Breakdown:    lines(q.Breakdown),
				ScheduleOnly: true,
			}
			return nil
		}
		row := quoteRow{
			Revision:     sub.Revision,
			Action:       q.Action,
			Months:       q.Months,
			TermStart:    &q.TermStart,
			TermEnd:      &q.TermEnd,
			PlanKey:      q.PlanKey,
			ExtraStores:  q.ExtraStores,
			ExtraMembers: q.ExtraMembers,
			KeepStores:   req.KeepStores,
			KeepMembers:  req.KeepMembers,
			Amount:       q.AmountCents,
			Breakdown:    q.Breakdown,
		}
		var id string
		if err := tx.QueryRow(ctx, `
			INSERT INTO subscription_quotes
			    (id, org_id, revision, action, months, term_start, term_end,
			     plan_key, extra_stores, extra_members, keep_store_ids, keep_member_ids,
			     amount_cents, breakdown, expires_at, created_at)
			VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, clock_timestamp())
			RETURNING id::text`,
			orgID, row.Revision, row.Action, row.Months, row.TermStart, row.TermEnd,
			row.PlanKey, row.ExtraStores, row.ExtraMembers, req.KeepStores, req.KeepMembers,
			row.Amount, mustJSON(row.Breakdown), now.Add(QuoteTTL)).Scan(&id); err != nil {
			return err
		}
		out = Offered{
			ID:          id,
			ExpiresAt:   ptrTime(now.Add(QuoteTTL)),
			Revision:    sub.Revision,
			Action:      q.Action,
			Current:     QuoteCurrent{PlanKey: sub.PlanKey, Stores: liveStores, Members: liveMembers, TermEnd: sub.TermEnd},
			Target:      QuoteTargetOut{PlanKey: q.PlanKey, Stores: q.Stores(), Members: q.Members()},
			AmountCents: q.AmountCents,
			Breakdown:   lines(q.Breakdown),
		}
		return nil
	})
	return out, err
}

// liveCapacity counts what the workspace uses now, for the keep-list check
// and the plan screen.
func liveCapacity(ctx context.Context, tx pgx.Tx, orgID int64) (int, int, error) {
	var stores, members int
	if err := tx.QueryRow(ctx, `
		SELECT
		    (SELECT count(*) FROM organization_stores
		      WHERE org_id = $1 AND deleted_at_ms IS NULL),
		    (SELECT count(*) FROM organization_members
		      WHERE org_id = $1 AND status = 'active' AND NOT manual_disabled)`, orgID).
		Scan(&stores, &members); err != nil {
		return 0, 0, err
	}
	return stores, members, nil
}

// writeSchedule stores a zero-amount capacity change. It lands at term_end,
// never now: a reduction inside a paid term is not refunded.
func writeSchedule(ctx context.Context, tx pgx.Tx, orgID int64, cat domain.Catalog, q domain.Quotation, req QuoteRequest, now time.Time) error {
	tag, err := tx.Exec(ctx, `
		UPDATE subscriptions
		   SET next_plan_key = $1, next_extra_stores = $2, next_extra_members = $3,
		       next_keep_store_ids = $4, next_keep_member_ids = $5,
		       revision = revision + 1, updated_at = clock_timestamp()
		 WHERE org_id = $6`, q.PlanKey, q.ExtraStores, q.ExtraMembers,
		req.KeepStores, req.KeepMembers, orgID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrNoSubscription
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO subscription_events
		    (org_id, kind, effective_at, plan_from, plan_to, stores_delta, members_delta,
		     term_start, term_end, breakdown, created_at)
		SELECT $1, 'schedule', term_end, plan_key, $2, $3 - extra_stores, $4 - extra_members,
		       term_start, term_end, $5, clock_timestamp()
		  FROM subscriptions WHERE org_id = $1`,
		orgID, q.PlanKey, q.ExtraStores, q.ExtraMembers, mustJSON(map[string]any{
			"keep_store_ids": req.KeepStores, "keep_member_ids": req.KeepMembers,
			"requested_at": now,
		}))
	return err
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return b
}

var errQuoteMissing = errors.New("quote not found")

// storedQuote is a quote row as the order path reads it.
type storedQuote struct {
	ID           int64
	OrgID        int64
	Revision     int64
	Action       string
	Months       int
	TermStart    time.Time
	TermEnd      time.Time
	PlanKey      string
	ExtraStores  int
	ExtraMembers int
	KeepStores   []string
	KeepMembers  []int64
	AmountCents  int64
	Breakdown    []domain.Line
	ExpiresAt    time.Time
	ConsumedAt   *time.Time
}

// claimQuote locks one quote and marks it used. The CAS on consumed_at is
// what stops two order creations from spending the same quote.
func claimQuote(ctx context.Context, tx pgx.Tx, orgID int64, quoteID string, now time.Time) (storedQuote, error) {
	var q storedQuote
	var breakdown []byte
	err := tx.QueryRow(ctx, `
		SELECT id, org_id, revision, action, months, term_start, term_end,
		       plan_key, extra_stores, extra_members, keep_store_ids, keep_member_ids,
		       amount_cents, breakdown, expires_at, consumed_at
		  FROM subscription_quotes
		 WHERE id = $1 AND org_id = $2
		 FOR UPDATE`, quoteID, orgID).Scan(
		&q.ID, &q.OrgID, &q.Revision, &q.Action, &q.Months, &q.TermStart, &q.TermEnd,
		&q.PlanKey, &q.ExtraStores, &q.ExtraMembers, &q.KeepStores, &q.KeepMembers,
		&q.AmountCents, &breakdown, &q.ExpiresAt, &q.ConsumedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return storedQuote{}, errQuoteMissing
	}
	if err != nil {
		return storedQuote{}, err
	}
	if q.ConsumedAt != nil {
		return storedQuote{}, &domain.QuoteError{Status: 409, Code: domain.CodeQuoteStale,
			Message: "该报价已用于下单"}
	}
	if !q.ExpiresAt.After(now) {
		return storedQuote{}, &domain.QuoteError{Status: 409, Code: domain.CodeQuoteExpired,
			Message: "报价已过期，请重新报价"}
	}
	tag, err := tx.Exec(ctx, `
		UPDATE subscription_quotes SET consumed_at = $2
		 WHERE id = $1 AND consumed_at IS NULL`, q.ID, now)
	if err != nil {
		return storedQuote{}, err
	}
	if tag.RowsAffected() != 1 {
		return storedQuote{}, &domain.QuoteError{Status: 409, Code: domain.CodeQuoteStale,
			Message: "该报价已用于下单"}
	}
	if err := json.Unmarshal(breakdown, &q.Breakdown); err != nil {
		return storedQuote{}, err
	}
	return q, nil
}

// lines converts the pricing core's line type to the wire type.
func lines(in []domain.Line) []contract.Line {
	out := make([]contract.Line, len(in))
	for i, l := range in {
		out[i] = contract.Line{Label: l.Label, Cents: l.Cents}
	}
	return out
}

func ptrTime(t time.Time) *time.Time { return &t }
