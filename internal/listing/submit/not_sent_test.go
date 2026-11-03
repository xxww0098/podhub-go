package submit

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

type afterBeginTransport struct {
	err           error
	ready, writes int
}

func (tr *afterBeginTransport) WritesDisabled() bool { return false }
func (tr *afterBeginTransport) Ready(context.Context) error {
	tr.ready++
	return nil
}
func (tr *afterBeginTransport) Write(context.Context, string, []byte) (int, string, error) {
	tr.writes++
	return 0, "", tr.err
}
func (tr *afterBeginTransport) Read(context.Context, string, []byte) (int, string, error) {
	return 0, "", errors.New("this test must not read upstream")
}

func TestAfterBeginTransportFailureSettlesOnlyProvenUnsentAttempts(t *testing.T) {
	for index, tc := range []struct {
		name   string
		batch  bool
		unsent bool
	}{
		{"single_not_sent", false, true},
		{"batch_not_sent", true, true},
		{"single_uncertain_network", false, false},
		{"batch_uncertain_network", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			count := 1
			if tc.batch {
				count = 2
			}
			f, ready, views, job, storePK := queuedTransportFixture(t, int64(986291+index), count)
			tr := &afterBeginTransport{err: errors.New("response lost after sending")}
			if tc.unsent {
				tr.err = fmt.Errorf("admission refused before dispatch: %w", ErrNotSent)
			}
			if tc.batch {
				if err := testSubmit().Work(f.ctx, f.pool, job, tr); err != nil {
					t.Fatal(err)
				}
			} else {
				in := Attempt{OrgID: f.org, IntentID: views[0].Intent.ID, RowID: ready[0].rowID,
					RowRevision: 1, StorePK: storePK, OfferID: ready[0].offerID,
					RequestHash: ready[0].digest, Body: ready[0].importBody, Lease: job.Lease()}
				out, err := testSubmit().RunAttempt(f.ctx, f.pool, tr, in)
				if err != nil {
					t.Fatal(err)
				}
				wantRequests := 1
				if tc.unsent {
					wantRequests = 0
				}
				if out.Requests != wantRequests {
					t.Fatalf("requests=%d want=%d", out.Requests, wantRequests)
				}
			}
			if tr.ready != 1 || tr.writes != 1 {
				t.Fatalf("transport was skipped or resent: ready=%d writes=%d", tr.ready, tr.writes)
			}
			for _, view := range views {
				var intentState, intentError, rowState, writeState, occupancy, reason, observation, writeError string
				var noStatus, noResponse bool
				var requestCount string
				err := f.pool.QueryRow(f.ctx, `
				 SELECT i.state, i.last_error_code, r.submission_state, w.state,
				        w.response_status IS NULL, w.response_body IS NULL,
				        COALESCE(w.error_code,''), COALESCE(w.last_observation->>'outcome',''),
				        COALESCE(w.last_observation->>'requests',''), o.state, COALESCE(o.release_reason,'')
				 FROM submission_intents i
				 JOIN listing_rows r ON r.org_id=i.org_id AND r.id=i.listing_row_id
				 JOIN seller_upstream_writes w ON w.org_id=i.org_id AND w.idempotency_key=i.id::text
				 JOIN seller_resource_occupancies o ON o.org_id=i.org_id AND o.owner_ref=i.id::text
				 WHERE i.org_id=$1 AND i.id=$2::uuid`, f.org, view.Intent.ID).Scan(
					&intentState, &intentError, &rowState, &writeState, &noStatus, &noResponse,
					&writeError, &observation, &requestCount, &occupancy, &reason)
				if err != nil {
					t.Fatal("begun attempt lost its durable ledger or occupancy", err)
				}
				if !noStatus || !noResponse {
					t.Fatal("transport failure invented an HTTP response")
				}
				if tc.unsent {
					if intentState != Rejected || rowState != Rejected || intentError != CodeEgressUnavailable || writeState != "reconciled" || occupancy != "released" || reason != "not_dispatched" || writeError != "not_dispatched" || observation != "not_dispatched" || requestCount != "0" {
						t.Fatalf("known unsent attempt retained locks/uncertainty: intent=%s/%s row=%s write=%s/%s observation=%s requests=%s occupancy=%s/%s", intentState, intentError, rowState, writeState, writeError, observation, requestCount, occupancy, reason)
					}
				} else if intentState != Unknown || rowState != Unknown || intentError != CodeDispatchInterrupted || writeState != "result_unknown" || occupancy != "held" || reason != "" || observation == "not_dispatched" {
					t.Fatalf("uncertain network failure lost its lock: intent=%s/%s row=%s write=%s occupancy=%s/%s", intentState, intentError, rowState, writeState, occupancy, reason)
				}
			}
			var jobState, result, jobError string
			if err := f.pool.QueryRow(f.ctx, `SELECT state,COALESCE(result_ref->>'outcome',''),COALESCE(last_error_code,'') FROM jobs WHERE id=$1`, job.ID).Scan(&jobState, &result, &jobError); err != nil {
				t.Fatal(err)
			}
			if tc.unsent {
				if jobState != "failed" || result != "not_dispatched" || jobError != CodeEgressUnavailable {
					t.Fatalf("known unsent job did not fail clearly: %s/%s/%s", jobState, result, jobError)
				}
			} else if jobState != "succeeded" || result != "unknown" || jobError != CodeDispatchInterrupted {
				t.Fatalf("uncertain job not parked for readback: %s/%s/%s", jobState, result, jobError)
			}
		})
	}
}
