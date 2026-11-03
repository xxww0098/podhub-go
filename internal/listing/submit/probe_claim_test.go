package submit

import (
	"testing"
	"time"
)

func TestUnknownProbeIgnoresResultFromReplacedClaim(t *testing.T) {
	f := newStoredRevisionFixture(t, 986239)
	ready := draftRows(t, f.ctx, f.pool, f.org, f.store, f.card, 1)
	seedIntent(t, f.ctx, f.pool, f.org, f.store, f.card, ready[0], Unknown, time.Now())
	var id string
	if err := f.pool.QueryRow(f.ctx, `UPDATE submission_intents SET reconcile_after=clock_timestamp()-interval '1 second',reconciliation_outcome='{"probe":{"passes":1,"observation":"absent"}}' WHERE org_id=$1 RETURNING id::text`, f.org).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE listing_rows SET submission_state='unknown' WHERE org_id=$1`, f.org); err != nil {
		t.Fatal(err)
	}
	claim := func() []claimedIntent {
		t.Helper()
		rows, err := claimDue(f.ctx, f.pool, 1)
		if err != nil || len(rows) != 1 || rows[0].ID != id {
			t.Fatalf("claim rows=%+v err=%v", rows, err)
		}
		return rows
	}
	old := claim()
	expired := append([]claimedIntent(nil), old...)
	if err := f.pool.QueryRow(f.ctx, `UPDATE submission_intents SET reconcile_claim_until=clock_timestamp()-interval '1 second' WHERE id=$1::uuid RETURNING reconcile_claim_until`, id).Scan(&expired[0].ClaimUntil); err != nil {
		t.Fatal(err)
	}
	if err := applyGroup(f.ctx, f.pool, f.org, expired, map[string]sightHit{id: {Sight: SightAbsent}}); err != nil {
		t.Fatal(err)
	}
	var expiredState string
	if err := f.pool.QueryRow(f.ctx, `SELECT state FROM submission_intents WHERE id=$1::uuid`, id).Scan(&expiredState); err != nil || expiredState != Unknown {
		t.Fatalf("expired claim applied a result: state=%s err=%v", expiredState, err)
	}
	current := claim()
	if err := applyGroup(f.ctx, f.pool, f.org, old, map[string]sightHit{id: {Sight: SightAbsent}}); err != nil {
		t.Fatal(err)
	}
	var state, rowState, observation string
	var passes int
	var claimUntil *time.Time
	if err := f.pool.QueryRow(f.ctx, `SELECT i.state,r.submission_state,COALESCE(i.reconciliation_outcome->'probe'->>'observation',''),COALESCE((i.reconciliation_outcome->'probe'->>'passes')::int,0),i.reconcile_claim_until FROM submission_intents i JOIN listing_rows r ON r.id=i.listing_row_id WHERE i.id=$1::uuid`, id).Scan(&state, &rowState, &observation, &passes, &claimUntil); err != nil {
		t.Fatal(err)
	}
	if state != Unknown || rowState != Unknown || observation != "absent" || passes != 1 || claimUntil == nil || !claimUntil.Equal(current[0].ClaimUntil) {
		t.Fatalf("old result changed the active replacement claim: state=%s row=%s observation=%s passes=%d claim=%v", state, rowState, observation, passes, claimUntil)
	}
	if err := applyGroup(f.ctx, f.pool, f.org, current, map[string]sightHit{id: {Sight: SightUnreadable}}); err != nil {
		t.Fatal(err)
	}
	// The slow previous read must not combine its stale absence streak with
	// its late result and release an intent the latest read could not verify.
	if err := applyGroup(f.ctx, f.pool, f.org, old, map[string]sightHit{id: {Sight: SightAbsent}}); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT i.state,r.submission_state,COALESCE(i.reconciliation_outcome->'probe'->>'observation',''),COALESCE((i.reconciliation_outcome->'probe'->>'passes')::int,0) FROM submission_intents i JOIN listing_rows r ON r.id=i.listing_row_id WHERE i.id=$1::uuid`, id).Scan(&state, &rowState, &observation, &passes); err != nil {
		t.Fatal(err)
	}
	if state != Unknown || rowState != Unknown || observation != "unreadable" || passes != 2 {
		t.Fatalf("stale probe changed latest evidence: state=%s row=%s observation=%s passes=%d", state, rowState, observation, passes)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE submission_intents SET reconcile_after=clock_timestamp()-interval '1 second' WHERE id=$1::uuid`, id); err != nil {
		t.Fatal(err)
	}
	current = claim()
	if err := applyGroup(f.ctx, f.pool, f.org, current, map[string]sightHit{id: {Sight: SightFound, Found: Found{ProductID: 9, SKU: 10}}}); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT i.state,r.submission_state FROM submission_intents i JOIN listing_rows r ON r.id=i.listing_row_id WHERE i.id=$1::uuid`, id).Scan(&state, &rowState); err != nil || state != Accepted || rowState != Accepted {
		t.Fatalf("current claim did not apply: state=%s row=%s err=%v", state, rowState, err)
	}
}
