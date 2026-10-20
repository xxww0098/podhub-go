package integration

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/listing/submit"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	queuecontract "github.com/xxww0098/podhub-go/internal/queue/contract"
	"github.com/xxww0098/podhub-go/internal/seller"
	sellerrepo "github.com/xxww0098/podhub-go/internal/seller/repo"
)

// Expectations below are transcribed from src/listing/kernel/submission at
// a03d735 (outcomes.rs, transport.rs, import_reconcile.rs). The Rust binary
// was not executed. Column values are what that source writes.

func TestSubmitSellerColumns(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	userID, orgID := insertWorkspace(t, ctx, pool, "submit-"+uuid.NewString()+"@example.com", "submit")
	storePK, storeID := insertStore(t, ctx, pool, orgID)
	insertCredential(t, ctx, pool, orgID, userID, storePK)

	t.Run("success", func(t *testing.T) {
		posts := serve(t, func(w http.ResponseWriter, body string) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"result":{"task_id":42}}`))
		})
		fx := seed(t, ctx, pool, orgID, storePK, storeID, "offer-ok")
		lease := runningJob(t, ctx, pool, fx, userID, false)
		eg := egress(t, posts.URL, false)
		if _, err := submit.RunAttempt(ctx, pool, eg.Port(), attempt(fx, lease, false)); err != nil {
			t.Fatal(err)
		}
		assertRow(t, ctx, pool, fx, rowWant{
			intent: "accepted", task: "42",
			write: "settled", status: 200, body: `{"result":{"task_id":42}}`,
			occ: "released", reason: "relationship_confirmed",
			listing: "accepted",
		})
		if posts.writes.Load() != 1 {
			t.Fatalf("posts %d", posts.writes.Load())
		}
		var jobState, result string
		var jobErr *string
		if err := pool.QueryRow(ctx, `SELECT state, last_error_code, result_ref::text FROM public.jobs WHERE id = $1`, lease.ID).Scan(&jobState, &jobErr, &result); err != nil {
			t.Fatal(err)
		}
		if jobState != "succeeded" || jobErr != nil || !strings.Contains(result, `"outcome": "accepted"`) && !strings.Contains(result, `"outcome":"accepted"`) {
			t.Fatalf("job %s %v %s", jobState, jobErr, result)
		}
	})

	t.Run("reject", func(t *testing.T) {
		posts := serve(t, func(w http.ResponseWriter, body string) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":3}`))
		})
		fx := seed(t, ctx, pool, orgID, storePK, storeID, "offer-reject")
		if _, err := submit.RunAttempt(ctx, pool, egress(t, posts.URL, false).Port(), attempt(fx, queuecontract.Lease{}, false)); err != nil {
			t.Fatal(err)
		}
		assertRow(t, ctx, pool, fx, rowWant{
			intent: "rejected", intentErr: "OZON_ROW_REJECTED",
			write: "settled", status: 400, body: `{"code":3}`,
			occ: "released", reason: "rejected_no_pending", listing: "rejected",
		})
		if posts.writes.Load() != 1 {
			t.Fatal(posts.writes.Load())
		}
	})

	t.Run("429", func(t *testing.T) {
		posts := serve(t, func(w http.ResponseWriter, body string) {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"code":8}`))
		})
		fx := seed(t, ctx, pool, orgID, storePK, storeID, "offer-limited")
		if _, err := submit.RunAttempt(ctx, pool, egress(t, posts.URL, false).Port(), attempt(fx, queuecontract.Lease{}, false)); err != nil {
			t.Fatal(err)
		}
		assertRow(t, ctx, pool, fx, rowWant{
			intent: "rejected", intentErr: "OZON_RATE_LIMITED",
			write: "settled", status: 429, body: `{"code":8}`,
			occ: "released", reason: "rejected_no_pending", listing: "rejected",
		})
	})

	t.Run("permission", func(t *testing.T) {
		posts := serve(t, func(w http.ResponseWriter, body string) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"code":7}`))
		})
		fx := seed(t, ctx, pool, orgID, storePK, storeID, "offer-perm")
		if _, err := submit.RunAttempt(ctx, pool, egress(t, posts.URL, false).Port(), attempt(fx, queuecontract.Lease{}, false)); err != nil {
			t.Fatal(err)
		}
		assertRow(t, ctx, pool, fx, rowWant{
			intent: "rejected", intentErr: "OZON_PERMISSION_DENIED",
			write: "settled", status: 403, body: `{"code":7}`,
			occ: "released", reason: "rejected_no_pending", listing: "rejected",
		})
	})

	t.Run("lost", func(t *testing.T) {
		posts := serve(t, func(w http.ResponseWriter, body string) {
			hj, ok := w.(http.Hijacker)
			if !ok {
				t.Fatal("hijack")
			}
			conn, _, err := hj.Hijack()
			if err != nil {
				t.Fatal(err)
			}
			conn.Close()
		})
		fx := seed(t, ctx, pool, orgID, storePK, storeID, "offer-lost")
		if _, err := submit.RunAttempt(ctx, pool, egress(t, posts.URL, false).Port(), attempt(fx, queuecontract.Lease{}, false)); err != nil {
			t.Fatal(err)
		}
		assertRow(t, ctx, pool, fx, rowWant{
			intent: "unknown", intentErr: "OZON_DISPATCH_INTERRUPTED",
			write: "result_unknown", occ: "held", listing: "unknown",
		})
		if posts.writes.Load() != 1 {
			t.Fatal(posts.writes.Load())
		}
	})

	t.Run("timeout", func(t *testing.T) {
		posts := serve(t, func(w http.ResponseWriter, body string) {
			time.Sleep(200 * time.Millisecond)
			w.WriteHeader(http.StatusOK)
		})
		fx := seed(t, ctx, pool, orgID, storePK, storeID, "offer-timeout")
		eg := egress(t, posts.URL, false)
		eg.SetTimeout(40 * time.Millisecond)
		if _, err := submit.RunAttempt(ctx, pool, eg.Port(), attempt(fx, queuecontract.Lease{}, false)); err != nil {
			t.Fatal(err)
		}
		assertRow(t, ctx, pool, fx, rowWant{
			intent: "unknown", intentErr: "OZON_DISPATCH_INTERRUPTED",
			write: "result_unknown", occ: "held", listing: "unknown",
		})
		if posts.writes.Load() != 1 {
			t.Fatal(posts.writes.Load())
		}
	})

	t.Run("crash then recover does not send again", func(t *testing.T) {
		posts := serve(t, func(w http.ResponseWriter, body string) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"result":{"task_id":7}}`))
		})
		fx := seed(t, ctx, pool, orgID, storePK, storeID, "offer-crash")
		eg := egress(t, posts.URL, false)
		_, err := submit.RunAttempt(ctx, pool, eg.Port(), attempt(fx, queuecontract.Lease{}, true))
		if !submit.Crashed(err) {
			t.Fatal(err)
		}
		assertRow(t, ctx, pool, fx, rowWant{
			intent: "submitting", write: "dispatching", occ: "held", listing: "submitting",
		})
		lease := runningJob(t, ctx, pool, fx, userID, false)
		if err := submit.Work(ctx, pool, queuecontract.Claimed{
			ID: lease.ID, OrgID: orgID, Kind: "listing.submit", SubmitterUserID: userID,
			Attempt: 1, MaxAttempts: 8, Epoch: lease.Epoch, Owner: lease.Owner,
			Payload: jobPayload(fx, false),
		}, eg.Port()); err != nil {
			t.Fatal(err)
		}
		assertRow(t, ctx, pool, fx, rowWant{
			intent: "unknown", intentErr: "OZON_SUBMIT_IN_FLIGHT",
			write: "result_unknown", occ: "held", listing: "unknown",
		})
		if posts.writes.Load() != 1 {
			t.Fatalf("second send %d", posts.writes.Load())
		}
	})

	t.Run("kill switch writes nothing and probe still reads", func(t *testing.T) {
		posts := serve(t, func(w http.ResponseWriter, body string) {
			if r := body; strings.Contains(r, "probe") {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"items":[]}`))
				return
			}
			w.WriteHeader(http.StatusOK)
		})
		fx := seed(t, ctx, pool, orgID, storePK, storeID, "offer-kill")
		eg := egress(t, posts.URL, true)
		if _, err := submit.RunAttempt(ctx, pool, eg.Port(), attempt(fx, queuecontract.Lease{}, false)); err != nil {
			t.Fatal(err)
		}
		assertRow(t, ctx, pool, fx, rowWant{
			intent: "rejected", intentErr: "OZON_WRITES_DISABLED", listing: "rejected",
		})
		if posts.writes.Load() != 0 || eg.WritePosts() != 0 {
			t.Fatalf("writes http %d egress %d", posts.writes.Load(), eg.WritePosts())
		}
		probeID := insertUnknownID(t, ctx, pool, orgID, storeID, "offer-probe-kill")
		if _, err := pool.Exec(ctx, `UPDATE public.submission_intents SET reconcile_after = clock_timestamp() - interval '1 second' WHERE id = $1`, probeID); err != nil {
			t.Fatal(err)
		}
		if _, err := submit.ProbeDue(ctx, pool, eg.Port(), 16); err != nil {
			t.Fatal(err)
		}
		if posts.reads.Load() == 0 || eg.ReadPosts() == 0 || posts.writes.Load() != 0 {
			t.Fatalf("probe reads %d writes %d", posts.reads.Load(), posts.writes.Load())
		}
	})

	t.Run("two absences release and one does not", func(t *testing.T) {
		posts := serve(t, func(w http.ResponseWriter, body string) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"items":[]}`))
		})
		id := insertUnknownID(t, ctx, pool, orgID, storeID, "offer-miss")
		eg := egress(t, posts.URL, false)
		if _, err := submit.ProbeDue(ctx, pool, eg.Port(), 16); err != nil {
			t.Fatal(err)
		}
		state, passes, observation := probeFact(t, ctx, pool, id)
		if state != "unknown" || passes != 1 || observation != "absent" {
			t.Fatalf("first miss %s %d %s", state, passes, observation)
		}
		if _, err := pool.Exec(ctx, `UPDATE public.submission_intents SET reconcile_after = clock_timestamp() - interval '1 second' WHERE id = $1`, id); err != nil {
			t.Fatal(err)
		}
		if _, err := submit.ProbeDue(ctx, pool, eg.Port(), 16); err != nil {
			t.Fatal(err)
		}
		state, passes, _ = probeFact(t, ctx, pool, id)
		var released int
		if err := pool.QueryRow(ctx, `SELECT COALESCE((reconciliation_outcome->'probeReleased'->>'passes')::int, 0) FROM public.submission_intents WHERE id = $1::uuid`, id).Scan(&released); err != nil {
			t.Fatal(err)
		}
		if state != "superseded" || released < 2 || passes != 0 {
			t.Fatalf("release %s passes %d released %d", state, passes, released)
		}
		var listing string
		rowID := rowForIntent(t, ctx, pool, id)
		if err := pool.QueryRow(ctx, `SELECT submission_state FROM public.listing_rows WHERE id = $1`, rowID).Scan(&listing); err != nil {
			t.Fatal(err)
		}
		if listing != "none" {
			t.Fatal(listing)
		}
		if posts.writes.Load() != 0 {
			t.Fatalf("probe imported %d", posts.writes.Load())
		}
	})

	t.Run("found accepts", func(t *testing.T) {
		id, offer := insertUnknown(t, ctx, pool, orgID, storeID, "offer-found")
		posts := serve(t, func(w http.ResponseWriter, body string) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"items":[{"id":9,"offer_id":"` + offer + `","sources":[{"sku":4}]}]}`))
		})
		if _, err := submit.ProbeDue(ctx, pool, egress(t, posts.URL, false).Port(), 16); err != nil {
			t.Fatal(err)
		}
		var state, found string
		if err := pool.QueryRow(ctx, `SELECT state, reconciliation_outcome::text FROM public.submission_intents WHERE id = $1`, id).Scan(&state, &found); err != nil {
			t.Fatal(err)
		}
		if state != "accepted" || !strings.Contains(found, `"productId": 9`) && !strings.Contains(found, `"productId":9`) || !strings.Contains(found, `"sku": 4`) && !strings.Contains(found, `"sku":4`) {
			t.Fatalf("%s %s", state, found)
		}
	})

	t.Run("illegal edge writes nothing", func(t *testing.T) {
		fx := seed(t, ctx, pool, orgID, storePK, storeID, "offer-illegal")
		if err := submit.ApplyStored(ctx, pool, orgID, fx.IntentID, submit.AcceptUnknown); !errors.Is(err, submit.ErrIllegalEdge) {
			t.Fatal(err)
		}
		assertRow(t, ctx, pool, fx, rowWant{intent: "queued", listing: "none"})
	})

	t.Run("lease budget admits one slot", func(t *testing.T) {
		wait, err := sellerrepo.Reserve(ctx, pool, "podhub", "client:default", time.Second/5, time.Second, 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if wait < 0 {
			t.Fatal(wait)
		}
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.lease_budget WHERE namespace = 'podhub' AND scope = 'client:default'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("lease rows %d", n)
		}
	})

	t.Run("missing org guc hides the intent", func(t *testing.T) {
		fx := seed(t, ctx, pool, orgID, storePK, storeID, "offer-guc")
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
			t.Fatal(err)
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM public.submission_intents WHERE id = $1`, fx.IntentID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("missing GUC saw %d", n)
		}
		if err := tenant.EnterApp(ctx, tx, orgID); err != nil {
			t.Fatal(err)
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM public.submission_intents WHERE id = $1`, fx.IntentID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("org saw %d", n)
		}
	})
}

type counted struct {
	URL    string
	writes *counter
	reads  *counter
}

type counter struct{ n int }

func (c *counter) Load() int { return c.n }
func (c *counter) Add()      { c.n++ }

func serve(t *testing.T, fn func(http.ResponseWriter, string)) *counted {
	t.Helper()
	c := &counted{writes: &counter{}, reads: &counter{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if r.URL.Path == "/v3/product/import" {
			c.writes.Add()
		} else {
			c.reads.Add()
		}
		fn(w, string(raw))
	}))
	t.Cleanup(srv.Close)
	c.URL = srv.URL
	return c
}

func egress(t *testing.T, base string, kill bool) *seller.Egress {
	t.Helper()
	t.Setenv("CLOUD_SELLER_BASE_URL", base+"/")
	if kill {
		t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	} else {
		t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	}
	cfg := config.Load()
	t.Setenv("OZON_WRITE_KILL_SWITCH", "")
	return seller.New(cfg)
}

func insertStore(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID int64) (int64, string) {
	t.Helper()
	id := uuid.NewString()
	var pk int64
	err := pool.QueryRow(ctx, `
		INSERT INTO public.organization_stores (org_id, uuid, create_order, name)
		VALUES ($1, $2::uuid, 1, 'submit') RETURNING id`, orgID, id).Scan(&pk)
	if err != nil {
		t.Fatal(err)
	}
	return pk, id
}

func insertCredential(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, userID, storePK int64) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO public.store_seller_credentials (
			store_id, org_id, credential_revision, client_id, key_id, nonce, ciphertext,
			key_fingerprint, registered_by_user_id, registered_at_ms
		) VALUES (
			$1, $2, 1, 'client', 'key',
			decode('000000000000000000000000', 'hex'),
			decode(repeat('ab', 17), 'hex'),
			decode(repeat('cd', 32), 'hex'),
			$3, 1
		)`, storePK, orgID, userID)
	if err != nil {
		t.Fatal(err)
	}
}

func seed(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, storePK int64, storeID, offer string) submit.Seed {
	t.Helper()
	row := submit.Seed{
		OrgID: orgID, StorePK: storePK, StoreID: storeID,
		IntentID: uuid.NewString(), RowID: uuid.NewString(), CardID: uuid.NewString(),
		OfferID: offer + "-" + uuid.NewString(), ClientOp: uuid.NewString(),
		RequestHash: "import", RowRevision: 1,
		Import: []byte(`{"items":[{"offer_id":"` + offer + `"}]}`),
	}
	if err := submit.InsertQueued(ctx, pool, row); err != nil {
		t.Fatal(err)
	}
	return row
}

func attempt(row submit.Seed, lease queuecontract.Lease, crash bool) submit.Attempt {
	return submit.Attempt{
		OrgID: row.OrgID, IntentID: row.IntentID, RowID: row.RowID, RowRevision: row.RowRevision,
		StorePK: row.StorePK, OfferID: row.OfferID, RequestHash: row.RequestHash,
		Body: row.Import, Lease: lease, CrashAfterSend: crash,
	}
}

func runningJob(t *testing.T, ctx context.Context, pool *pgxpool.Pool, row submit.Seed, userID int64, crash bool) queuecontract.Lease {
	t.Helper()
	id := uuid.NewString()
	_, err := pool.Exec(ctx, `
		INSERT INTO public.jobs (
			id, org_id, kind, aggregate_type, aggregate_id, input_revision, idempotency_key,
			state, attempt, max_attempts, lane, submitter_user_id, payload, cost_units,
			lease_owner, lease_epoch, lease_until
		) VALUES (
			$1::uuid, $2, 'listing.submit', 'listing_row', $3::uuid, $4, $5,
			'running', 1, 8, 'listing.submit', $6, $7::jsonb, 4,
			'listing-test', 1, clock_timestamp() + interval '5 minutes'
		)`, id, row.OrgID, row.RowID, row.RowRevision, "job-"+id, userID, string(jobPayload(row, crash)))
	if err != nil {
		t.Fatal(err)
	}
	return queuecontract.Lease{
		ID: uuid.MustParse(id), Owner: "listing-test", Epoch: 1,
		Kind: "listing.submit", Attempt: 1, MaxAttempts: 8,
		UserID: userID, Lane: "listing.submit",
	}
}

func jobPayload(row submit.Seed, crash bool) []byte {
	crashText := "false"
	if crash {
		crashText = "true"
	}
	return []byte(`{"intentId":"` + row.IntentID + `","rowId":"` + row.RowID + `","rowRevision":1,"storePk":` + strconv.FormatInt(row.StorePK, 10) + `,"offerId":"` + row.OfferID + `","requestHash":"import","import":{"items":[]},"crashAfterSend":` + crashText + `}`)
}

func insertUnknownID(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID int64, storeID, offer string) string {
	id, _ := insertUnknown(t, ctx, pool, orgID, storeID, offer)
	return id
}

func insertUnknown(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID int64, storeID, offer string) (string, string) {
	t.Helper()
	row := seed(t, ctx, pool, orgID, 0, storeID, offer)
	_, err := pool.Exec(ctx, `
		UPDATE public.submission_intents
		   SET state = 'unknown', reconcile_after = clock_timestamp() - interval '1 second'
		 WHERE id = $1::uuid`, row.IntentID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		UPDATE public.listing_rows SET submission_state = 'unknown' WHERE id = $1::uuid`, row.RowID)
	if err != nil {
		t.Fatal(err)
	}
	return row.IntentID, row.OfferID
}

func probeFact(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string) (string, int, string) {
	t.Helper()
	var state, observation string
	var passes int
	err := pool.QueryRow(ctx, `
		SELECT state,
		       COALESCE((reconciliation_outcome->'probe'->>'passes')::int, 0),
		       COALESCE(reconciliation_outcome->'probe'->>'observation', '')
		  FROM public.submission_intents WHERE id = $1::uuid`, id).Scan(&state, &passes, &observation)
	if err != nil {
		t.Fatal(err)
	}
	return state, passes, observation
}

func rowForIntent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string) string {
	t.Helper()
	var row string
	if err := pool.QueryRow(ctx, `SELECT listing_row_id::text FROM public.submission_intents WHERE id = $1::uuid`, id).Scan(&row); err != nil {
		t.Fatal(err)
	}
	return row
}

type rowWant struct {
	intent, intentErr, task string
	write                   string
	status                  int
	body                    string
	occ, reason             string
	listing                 string
}

func assertRow(t *testing.T, ctx context.Context, pool *pgxpool.Pool, row submit.Seed, want rowWant) {
	t.Helper()
	var state, intentErr, task string
	var taskNull, errNull bool
	var taskPtr, errPtr *string
	if err := pool.QueryRow(ctx, `
		SELECT state, last_error_code, external_task_id
		  FROM public.submission_intents WHERE id = $1::uuid`, row.IntentID).Scan(&state, &errPtr, &taskPtr); err != nil {
		t.Fatal(err)
	}
	if errPtr != nil {
		intentErr = *errPtr
	} else {
		errNull = true
	}
	if taskPtr != nil {
		task = *taskPtr
	} else {
		taskNull = true
	}
	if state != want.intent || intentErr != want.intentErr || (want.task == "" && !taskNull) || (want.task != "" && task != want.task) {
		t.Fatalf("intent %s err %q (null %v) task %q (null %v)", state, intentErr, errNull, task, taskNull)
	}
	var writeState string
	var writeBody *string
	var status *int32
	err := pool.QueryRow(ctx, `
		SELECT state, response_status, convert_from(response_body, 'UTF8')
		  FROM public.seller_upstream_writes WHERE idempotency_key = $1`, row.IntentID).Scan(&writeState, &status, &writeBody)
	gotBody := ""
	if writeBody != nil {
		gotBody = *writeBody
	}
	if want.write == "" {
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("write row %v %s", err, writeState)
		}
	} else if err != nil || writeState != want.write || (want.status == 0 && status != nil) || (want.status != 0 && (status == nil || int(*status) != want.status)) || gotBody != want.body {
		got := 0
		if status != nil {
			got = int(*status)
		}
		t.Fatalf("write %s status %d body %q err %v", writeState, got, gotBody, err)
	}
	var occ, reason string
	var reasonPtr *string
	err = pool.QueryRow(ctx, `
		SELECT state, release_reason FROM public.seller_resource_occupancies WHERE owner_ref = $1`, row.IntentID).Scan(&occ, &reasonPtr)
	if want.occ == "" {
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("occupancy %v %s", err, occ)
		}
	} else if err != nil || occ != want.occ {
		t.Fatalf("occupancy %s %v", occ, err)
	} else {
		if reasonPtr != nil {
			reason = *reasonPtr
		}
		if reason != want.reason {
			t.Fatalf("reason %s", reason)
		}
	}
	var listing string
	if err := pool.QueryRow(ctx, `SELECT submission_state FROM public.listing_rows WHERE id = $1::uuid`, row.RowID).Scan(&listing); err != nil {
		t.Fatal(err)
	}
	if listing != want.listing {
		t.Fatalf("row %s", listing)
	}
}
