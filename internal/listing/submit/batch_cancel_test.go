package submit

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"

	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
)

type capturedBatchTransport struct {
	receivedStoreTransport
	ids    []string
	body   []byte
	onBind func() error
}

func (tr *capturedBatchTransport) BindStore(_ context.Context, scope sellercontract.StoreBinding) (Transport, error) {
	tr.ids = append([]string(nil), scope.IntentIDs...)
	tr.binds++
	if tr.onBind != nil {
		if err := tr.onBind(); err != nil {
			return nil, err
		}
	}
	return tr, nil
}

func (tr *capturedBatchTransport) Write(ctx context.Context, path string, body []byte) (int, string, error) {
	tr.body = append([]byte(nil), body...)
	return tr.receivedStoreTransport.Write(ctx, path, body)
}

func TestBatchExcludesCancelledRowsFromBindingAndRequest(t *testing.T) {
	for index, cancelled := range [][]int{nil, {0}, {1}, {2}, {0, 1, 2}} {
		t.Run(fmt.Sprint(cancelled), func(t *testing.T) {
			f, ready, views, job, _ := queuedTransportFixture(t, 986810+int64(index), 3)
			for _, i := range cancelled {
				if _, err := f.pool.Exec(f.ctx, `UPDATE submission_intents SET state='cancelled',cancel_requested_at=clock_timestamp() WHERE id=$1::uuid`, views[i].Intent.ID); err != nil {
					t.Fatal(err)
				}
			}
			tr := &capturedBatchTransport{}
			if err := testSubmit().Work(f.ctx, f.pool, job, tr); err != nil {
				t.Fatal(err)
			}
			var ids, offers []string
			for i, view := range views {
				var state string
				if err := f.pool.QueryRow(f.ctx, `SELECT state FROM submission_intents WHERE id=$1::uuid`, view.Intent.ID).Scan(&state); err != nil {
					t.Fatal(err)
				}
				wasCancelled := false
				for _, n := range cancelled {
					wasCancelled = wasCancelled || n == i
				}
				if wasCancelled {
					if state != Cancelled {
						t.Fatalf("cancelled row %d changed to %s", i, state)
					}
					continue
				}
				if state != Accepted {
					t.Fatalf("uncancelled row %d was not sent: %s", i, state)
				}
				ids = append(ids, view.Intent.ID)
				offers = append(offers, ready[i].offerID)
			}
			if !reflect.DeepEqual(tr.ids, ids) {
				t.Fatalf("credential targets=%v, want %v", tr.ids, ids)
			}
			var body struct {
				Items []struct {
					Offer string `json:"offer_id"`
				} `json:"items"`
			}
			var sent []string
			if len(tr.body) > 0 {
				if err := json.Unmarshal(tr.body, &body); err != nil {
					t.Fatal(err)
				}
				for _, item := range body.Items {
					sent = append(sent, item.Offer)
				}
			}
			if !reflect.DeepEqual(sent, offers) {
				t.Fatalf("sent offers=%v, want %v", sent, offers)
			}
			var jobState string
			if err := f.pool.QueryRow(f.ctx, `SELECT state FROM jobs WHERE id=$1`, job.ID).Scan(&jobState); err != nil {
				t.Fatal(err)
			}
			if len(offers) == 0 {
				if jobState != "cancelled" || tr.binds != 0 || tr.writes != 0 {
					t.Fatalf("empty batch: job=%s binds=%d writes=%d", jobState, tr.binds, tr.writes)
				}
			} else if jobState != "succeeded" || tr.writes != 1 {
				t.Fatalf("job=%s writes=%d", jobState, tr.writes)
			}
		})
	}
}

func TestBatchBeginRollsBackWhenLaterOfferIsBusy(t *testing.T) {
	f, ready, _, job, storePK := queuedTransportFixture(t, 986815, 2)
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO seller_resource_occupancies(org_id,store_pk,physical_account_key,resource_kind,resource_key,owner_kind,owner_ref,spec_digest) VALUES($1,$2,'loopback','offer',$3,'store_write','other-write','hash')`, f.org, storePK, ready[1].offerID); err != nil {
		t.Fatal(err)
	}
	tr := &capturedBatchTransport{}
	if err := testSubmit().Work(f.ctx, f.pool, job, tr); err == nil {
		t.Fatal("busy offer admitted")
	}
	var queued, writes int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM submission_intents WHERE org_id=$1 AND state='queued'`, f.org).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM seller_upstream_writes WHERE org_id=$1`, f.org).Scan(&writes); err != nil {
		t.Fatal(err)
	}
	if queued != 2 || writes != 0 || tr.writes != 0 {
		t.Fatalf("partial begin escaped rollback: queued=%d ledger=%d requests=%d", queued, writes, tr.writes)
	}
}

func TestBatchRetriesBindingWhenCancellationChangesTargets(t *testing.T) {
	f, _, views, job, _ := queuedTransportFixture(t, 986818, 2)
	var original batchJob
	if err := json.Unmarshal(job.Payload, &original); err != nil {
		t.Fatal(err)
	}
	tr := &capturedBatchTransport{}
	tr.onBind = func() error {
		if tr.binds != 1 {
			return nil
		}
		if _, err := f.pool.Exec(f.ctx, `UPDATE submission_intents SET state='cancelled',cancel_requested_at=clock_timestamp() WHERE id=$1::uuid`, views[0].Intent.ID); err != nil {
			return err
		}
		return ErrNotSent
	}
	if err := testSubmit().Work(f.ctx, f.pool, job, tr); err != nil {
		t.Fatal(err)
	}
	if tr.binds != 2 || !reflect.DeepEqual(tr.ids, []string{views[1].Intent.ID}) || tr.writes != 1 || string(tr.body) != string(original.Intents[1].Import) {
		t.Fatalf("binding race rejected or sent wrong targets: binds=%d ids=%v writes=%d body=%s", tr.binds, tr.ids, tr.writes, tr.body)
	}
}

func TestBatchRechecksCancellationAfterWaitingForOrganization(t *testing.T) {
	f, _, views, job, _ := queuedTransportFixture(t, 986816, 2)
	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.ctx)
	if _, err := tx.Exec(f.ctx, `SELECT id FROM organizations WHERE id=$1 FOR NO KEY UPDATE`, f.org); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(f.ctx, 10*time.Second)
	defer cancel()
	tr := &capturedBatchTransport{}
	done := make(chan error, 1)
	go func() { done <- testSubmit().Work(ctx, f.pool, job, tr) }()
	for {
		var waiting bool
		if err := f.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM public.organizations%')`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("batch skipped organization lock: %v", err)
		case <-ctx.Done():
			t.Fatal("worker did not reach organization lock")
		case <-time.After(5 * time.Millisecond):
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE submission_intents SET state='cancelled',cancel_requested_at=clock_timestamp() WHERE id=$1::uuid`, views[0].Intent.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(tr.ids, []string{views[1].Intent.ID}) || tr.writes != 1 {
		t.Fatalf("late cancellation was ignored: ids=%v writes=%d", tr.ids, tr.writes)
	}
}
