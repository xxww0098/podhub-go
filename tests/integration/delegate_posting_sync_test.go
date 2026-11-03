package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/app/scans"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	delegatecontract "github.com/xxww0098/podhub-go/internal/delegate/contract"
	delegaterepo "github.com/xxww0098/podhub-go/internal/delegate/repo"
	delegatesvc "github.com/xxww0098/podhub-go/internal/delegate/service"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	queuecontract "github.com/xxww0098/podhub-go/internal/queue/contract"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
	seller "github.com/xxww0098/podhub-go/internal/seller/ozon"
)

type delegateSyncFixture struct {
	identityRuntimeFixture
	worker             *pgxpool.Pool
	repo               delegaterepo.Repo
	api                delegatesvc.Seller
	org                int64
	workspace, store   uuid.UUID
	binding, fulfiller string
	source             string
}

func newDelegateSyncFixture(t *testing.T, reply func(http.ResponseWriter, *http.Request)) delegateSyncFixture {
	t.Helper()
	f := delegateSyncFixture{identityRuntimeFixture: newIdentityRuntimeFixture(t), store: uuid.New(), source: "sync-" + uuid.NewString()}
	if err := f.fixture.QueryRow(f.ctx, `SELECT id,uuid FROM organizations WHERE owner_user_id=96311`).Scan(&f.org, &f.workspace); err != nil {
		t.Fatal(err)
	}
	seedCompanyStore(t, f.ctx, f.fixture, f.org, f.store.String(), 1, "Sync store", nil)
	var pk int64
	if err := f.fixture.QueryRow(f.ctx, `SELECT id FROM organization_stores WHERE uuid=$1`, f.store).Scan(&pk); err != nil {
		t.Fatal(err)
	}
	kek := seal.DeriveKEK(strings.Repeat("k", 32))
	nonce, ciphertext, err := seal.SealBlob(kek, seal.StoreAAD(f.org, pk, 1), []byte("sync-client\x00sync-key"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO store_seller_credentials(store_id,org_id,credential_revision,client_id,key_id,nonce,ciphertext,key_fingerprint,registered_by_user_id,registered_at_ms,envelope_version)
	 VALUES($1,$2,1,'sync-client','k1',$3,$4,$5,96311,1,1)`, pk, f.org, nonce, ciphertext, seal.Fingerprint(kek, "sync-client", "sync-key")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `UPDATE organization_stores SET credential_revision=1,client_id='sync-client' WHERE id=$1`, pk); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO sc_sources(source_id,name,listed,accepts_delegate,created_at_ms,updated_at_ms) VALUES($1,'Sync source',true,true,1,1)`, f.source); err != nil {
		t.Fatal(err)
	}
	var supplier int64
	if err := f.fixture.QueryRow(f.ctx, `INSERT INTO account_users(public_id,email,password_hash,account_kind,role,name,created_at,updated_at)
	 VALUES(gen_random_uuid()::text,$1,'fixture','supplier','user','Sync factory',clock_timestamp(),clock_timestamp()) RETURNING id`, uuid.NewString()+"@example.invalid").Scan(&supplier); err != nil {
		t.Fatal(err)
	}
	if err := f.fixture.QueryRow(f.ctx, `INSERT INTO sc_source_fulfillers(source_id,user_id,created_by,created_at_ms) VALUES($1,$2,96311,1) RETURNING fulfiller_id::text`, f.source, supplier).Scan(&f.fulfiller); err != nil {
		t.Fatal(err)
	}
	if err := f.fixture.QueryRow(f.ctx, `INSERT INTO delegate_bindings(org_id,store_id,offer_id,source_id,created_by,created_at_ms,updated_at_ms)
	 VALUES($1,$2,'sync-offer',$3,96311,1,1) RETURNING binding_id::text`, f.org, f.store, f.source).Scan(&f.binding); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO delegate_assets(org_id,binding_id,object_key,sha256,bytes,mime,file_name,verified_at_ms,created_at_ms)
	 VALUES($1,$2::uuid,'sync/fixture.png',repeat('a',64),1,'image/png','fixture.png',1,1)`, f.org, f.binding); err != nil {
		t.Fatal(err)
	}
	seedMatchingLease(t, f.ctx, f.fixture, "entitlement", "delegate sync regression")
	if _, err := f.fixture.Exec(f.ctx, `ALTER ROLE podhub_login_reconciler PASSWORD 'delegate-sync-regression'`); err != nil {
		t.Fatal(err)
	}
	f.worker, err = db.Connect(f.ctx, config.Config{DatabaseURL: swapUser(f.fixture.Config().ConnString(), "podhub_login_reconciler", "delegate-sync-regression")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.worker.Close)
	f.repo = delegaterepo.New(f.worker, tenant.BeginApp)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v3/posting/fbs/get" || r.Header.Get("Client-Id") != "sync-client" || r.Header.Get("Api-Key") != "sync-key" {
			t.Error("sync escaped its authorized read port")
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		reply(w, r)
	}))
	t.Cleanup(server.Close)
	t.Setenv("CLOUD_SELLER_BASE_URL", server.URL+"/")
	eg := seller.New(config.Load()).WithPool(f.worker)
	f.api = delegatesvc.Seller{DB: f.repo, Auto: true, Edge: delegatesvc.Edge{
		Open: func(c delegatecontract.SealedCredential) (string, string, error) {
			return seal.OpenStored("k1", c.KeyID, kek, nil, c.OrgID, c.StorePK, c.CredentialRevision, c.Nonce, c.Ciphertext, c.WrappedDEK, c.DEKNonce)
		},
		Seller: func(ctx context.Context, client, key, path string, body []byte) (int, []byte, string, error) {
			reply, err := eg.SellerReadCall(ctx, http.MethodPost, path, body, false, true, client, key)
			return reply.Status, []byte(reply.Body), "", err
		},
	}}
	return f
}

func (f delegateSyncFixture) order(t *testing.T, posting, state, packet string, held bool) (string, string) {
	t.Helper()
	var order, line, dispatch string
	if err := f.fixture.QueryRow(f.ctx, `INSERT INTO delegate_orders(org_id,store_id,posting_number,state,created_at_ms,updated_at_ms)
	 VALUES($1,$2,$3,$4,1,1) RETURNING order_id::text`, f.org, f.store, posting, state).Scan(&order); err != nil {
		t.Fatal(err)
	}
	if err := f.fixture.QueryRow(f.ctx, `INSERT INTO delegate_order_lines(org_id,order_id,offer_id,quantity,binding_id)
	 VALUES($1,$2::uuid,'sync-offer',1,$3::uuid) RETURNING line_id::text`, f.org, order, f.binding).Scan(&line); err != nil {
		t.Fatal(err)
	}
	if packet == "" {
		return order, dispatch
	}
	payload := fmt.Sprintf(`{"lines":[{"line_id":%q}],"posting_number":%q}`, line, posting)
	if err := f.fixture.QueryRow(f.ctx, `INSERT INTO delegate_dispatches(org_id,order_id,source_id,dispatch_no,payload,state,fulfiller_id,created_at_ms,updated_at_ms)
	 VALUES($1,$2::uuid,$3,$4,$5::jsonb,$6,$7::uuid,1,1) RETURNING dispatch_id::text`, f.org, order, f.source, "dsp_"+uuid.NewString(), payload, packet, f.fulfiller).Scan(&dispatch); err != nil {
		t.Fatal(err)
	}
	if held {
		if _, err := billingrepo.Adjust(f.ctx, f.fixture, f.org, "fund:"+dispatch, 2_000_000, "sync fixture"); err != nil {
			t.Fatal(err)
		}
		if err := db.InTx(f.ctx, f.fixture, db.App(f.org), func(tx pgx.Tx) error {
			_, err := billingrepo.HoldTx(f.ctx, tx, f.org, "delegate:"+dispatch, nil, 1_000_000)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO delegate_settlements(org_id,order_id,dispatch_id,source_id,amount_cents,amount_microfen,state,breakdown,held_at_ms)
		 VALUES($1,$2::uuid,$3::uuid,$4,1,1000000,'held','{}',1)`, f.org, order, dispatch, f.source); err != nil {
			t.Fatal(err)
		}
	}
	return order, dispatch
}

func (f delegateSyncFixture) claim(t *testing.T) queuecontract.Claimed {
	t.Helper()
	_, err := queuerepo.Enqueue(f.ctx, f.worker, []queuecontract.NewJob{{ID: uuid.New(), OrgID: f.org, Kind: "delegate.posting_sync", AggregateType: "organization", AggregateID: f.workspace, InputRevision: 1, IdempotencyKey: uuid.NewString(), Payload: []byte(`{}`), SubmitterUserID: 96311, MaxAttempts: 3, Priority: 100, RunAt: time.Now()}}, 100)
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := queuerepo.Claim(f.ctx, f.worker, "delegate.posting_sync", "delegate-sync-test", 1)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("claim jobs=%+v err=%v", jobs, err)
	}
	return jobs[0]
}

func TestDelegatePostingSyncProductionRole(t *testing.T) {
	f := newDelegateSyncFixture(t, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Posting string `json:"posting_number"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		status := "awaiting_packaging"
		if strings.Contains(body.Posting, "cancel") {
			status = "cancelled"
		} else if strings.Contains(body.Posting, "delivered") {
			status = "delivered"
		}
		fmt.Fprintf(w, `{"result":{"posting_number":%q,"status":%q,"customer":{"name":"PRIVATE"},"delivery_method":{"name":"OGL","warehouse":"Moscow"}}}`, body.Posting, status)
	})
	cancel, _ := f.order(t, "cancel", "dispatched", "dispatched", true)
	accepted, _ := f.order(t, "accepted-cancel", "in_production", "accepted", true)
	delivered, _ := f.order(t, "delivered", "shipped", "shipped", false)
	early, _ := f.order(t, "early-delivered", "ready", "", false)
	normal, _ := f.order(t, "normal", "ready", "", false)
	job := f.claim(t)
	if err := scans.RunDelegate(f.ctx, f.worker, job, f.repo, f.api); err != nil {
		t.Fatal(err)
	}
	for _, want := range []struct {
		id, state, money string
		cancel           bool
	}{
		{cancel, "cancelled", "released", false}, {accepted, "in_production", "held", true}, {delivered, "done", "", false}, {early, "ready", "", false}, {normal, "dispatched", "", false},
	} {
		var state, snapshot, money string
		var cancelled bool
		if err := f.fixture.QueryRow(f.ctx, `SELECT state,cancel_requested,posting_snapshot::text,COALESCE((SELECT state FROM delegate_settlements WHERE order_id=o.order_id),'') FROM delegate_orders o WHERE order_id=$1::uuid`, want.id).Scan(&state, &cancelled, &snapshot, &money); err != nil || state != want.state || cancelled != want.cancel || money != want.money || strings.Contains(snapshot, "PRIVATE") {
			t.Fatalf("order %s state=%s cancel=%v money=%s snapshot=%s err=%v", want.id, state, cancelled, money, snapshot, err)
		}
	}
	var held int64
	var state string
	if err := f.fixture.QueryRow(f.ctx, `SELECT held_microfen FROM workspace_wallets WHERE org_id=$1`, f.org).Scan(&held); err != nil || held != 1_000_000 {
		t.Fatalf("accepted production funds were released: held=%d err=%v", held, err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT state FROM jobs WHERE id=$1`, job.ID).Scan(&state); err != nil || state != "succeeded" {
		t.Fatalf("job %s err=%v", state, err)
	}
	f.assertClean(t)
}

func TestDelegatePostingSyncFencesAndRefusals(t *testing.T) {
	for _, scenario := range []string{"read failure", "mismatched posting", "stale order", "lost epoch", "auto disabled", "missing logistics", "cancel requested", "unknown upstream state"} {
		t.Run(scenario, func(t *testing.T) {
			var f delegateSyncFixture
			var order string
			var job queuecontract.Claimed
			f = newDelegateSyncFixture(t, func(w http.ResponseWriter, _ *http.Request) {
				if scenario == "read failure" {
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				posting, status := "P1", "awaiting_packaging"
				if scenario == "mismatched posting" {
					posting = "other-order"
				}
				if scenario == "unknown upstream state" {
					status = "new_platform_state"
				}
				if scenario == "stale order" {
					if _, err := f.fixture.Exec(f.ctx, `UPDATE delegate_orders SET updated_at_ms=2,posting_snapshot='{"status":"newer"}' WHERE order_id=$1::uuid`, order); err != nil {
						t.Error(err)
					}
				}
				if scenario == "lost epoch" {
					if _, err := f.fixture.Exec(f.ctx, `UPDATE jobs SET lease_epoch=lease_epoch+1 WHERE id=$1`, job.ID); err != nil {
						t.Error(err)
					}
				}
				logistics := `,"delivery_method":{"name":"OGL"}`
				if scenario == "missing logistics" {
					logistics = ""
				}
				fmt.Fprintf(w, `{"result":{"posting_number":%q,"status":%q%s}}`, posting, status, logistics)
			})
			order, _ = f.order(t, "P1", "ready", "", false)
			if scenario == "auto disabled" {
				f.api.Auto = false
			}
			if scenario == "cancel requested" {
				if _, err := f.fixture.Exec(f.ctx, `UPDATE delegate_orders SET cancel_requested=true WHERE order_id=$1::uuid`, order); err != nil {
					t.Fatal(err)
				}
			}
			job = f.claim(t)
			err := scans.RunDelegate(f.ctx, f.worker, job, f.repo, f.api)
			failed := scenario == "read failure" || scenario == "mismatched posting"
			if (err != nil) != failed {
				t.Fatalf("sync error=%v expected failure=%v", err, failed)
			}
			var state, snapshot, jobState string
			var packets int
			if err := f.fixture.QueryRow(f.ctx, `SELECT state,posting_snapshot::text,(SELECT count(*) FROM delegate_dispatches WHERE order_id=o.order_id),(SELECT state FROM jobs WHERE id=$2) FROM delegate_orders o WHERE order_id=$1::uuid`, order, job.ID).Scan(&state, &snapshot, &packets, &jobState); err != nil || state != "ready" || packets != 0 {
				t.Fatalf("sync changed fenced/blocked order: state=%s packets=%d err=%v", state, packets, err)
			}
			if failed || scenario == "lost epoch" {
				if snapshot != "{}" || jobState != "running" {
					t.Fatalf("failed or late read was applied: snapshot=%s job=%s", snapshot, jobState)
				}
			} else if jobState != "succeeded" || scenario == "stale order" && !strings.Contains(snapshot, "newer") {
				t.Fatalf("stale receipt overwrote state or did not settle: snapshot=%s job=%s", snapshot, jobState)
			}
		})
	}
}

func TestDelegatePostingSyncScanReachesEveryWorkspace(t *testing.T) {
	f := newDelegateSyncFixture(t, func(http.ResponseWriter, *http.Request) {
		t.Fatal("enqueue scan must not call Seller")
	})
	for i := 0; i < 17; i++ {
		org, _ := seedAITenant(t, f.ctx, f.fixture, int64(98400+i))
		store := uuid.NewString()
		seedCompanyStore(t, f.ctx, f.fixture, org, store, 1, "Fairness store", nil)
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO delegate_orders(org_id,store_id,posting_number,state,created_at_ms,updated_at_ms) VALUES($1,$2::uuid,'P1','ready',1,1)`, org, store); err != nil {
			t.Fatal(err)
		}
	}
	for _, want := range []int{16, 1, 0} {
		if got, err := scans.EnqueueDelegateSync(f.ctx, f.worker, 16, time.Minute); err != nil || got != want {
			t.Fatalf("fair scan enqueued=%d want=%d err=%v", got, want, err)
		}
	}
	var workspaces int
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(DISTINCT org_id) FROM jobs WHERE kind='delegate.posting_sync'`).Scan(&workspaces); err != nil || workspaces != 17 {
		t.Fatalf("scan reached %d workspaces: %v", workspaces, err)
	}
}

func TestDelegatePostingSyncPausedOrdersStillSettle(t *testing.T) {
	for _, pause := range []string{"manual", "quota", "expired capacity", "disabled account"} {
		t.Run(pause, func(t *testing.T) {
			f := newDelegateSyncFixture(t, func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Posting string `json:"posting_number"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				status := "awaiting_packaging"
				if strings.Contains(body.Posting, "cancel") {
					status = "cancelled"
				} else if body.Posting == "delivered" {
					status = "delivered"
				}
				fmt.Fprintf(w, `{"result":{"posting_number":%q,"status":%q,"delivery_method":{"name":"OGL"}}}`, body.Posting, status)
			})
			cancel, _ := f.order(t, "cancel", "dispatched", "dispatched", true)
			accepted, _ := f.order(t, "accepted-cancel", "in_production", "accepted", true)
			delivered, _ := f.order(t, "delivered", "shipped", "shipped", false)
			ready, _ := f.order(t, "ready", "ready", "", false)
			var query string
			switch pause {
			case "manual":
				query = `UPDATE organization_stores SET manual_disabled=true WHERE org_id=$1`
			case "quota":
				query = `UPDATE organization_stores SET quota_suspended=true WHERE org_id=$1`
			case "disabled account":
				query = `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=(SELECT owner_user_id FROM organizations WHERE id=$1)`
			case "expired capacity":
				if _, err := f.fixture.Exec(f.ctx, `UPDATE organization_stores SET create_order=2 WHERE org_id=$1`, f.org); err != nil {
					t.Fatal(err)
				}
				seedCompanyStore(t, f.ctx, f.fixture, f.org, uuid.NewString(), 1, "Free capacity survivor", nil)
				query = `INSERT INTO subscriptions(org_id,status,plan_key,stores,term_start,term_end,updated_at) VALUES($1,'expired','lite',2,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',clock_timestamp())`
			}
			if _, err := f.fixture.Exec(f.ctx, query, f.org); err != nil {
				t.Fatal(err)
			}
			if err := scans.RunDelegate(f.ctx, f.worker, f.claim(t), f.repo, f.api); err != nil {
				t.Fatal(err)
			}
			for _, want := range []struct{ id, state string }{{cancel, "cancelled"}, {accepted, "in_production"}, {delivered, "done"}, {ready, "ready"}} {
				var state string
				if err := f.fixture.QueryRow(f.ctx, `SELECT state FROM delegate_orders WHERE order_id=$1::uuid`, want.id).Scan(&state); err != nil || state != want.state {
					t.Fatalf("paused order did not converge: state=%s want=%s err=%v", state, want.state, err)
				}
			}
			var packets int
			var held int64
			if err := f.fixture.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM delegate_dispatches WHERE order_id=$1::uuid),(SELECT held_microfen FROM workspace_wallets WHERE org_id=$2)`, ready, f.org).Scan(&packets, &held); err != nil || packets != 0 || held != 1_000_000 {
				t.Fatalf("paused order created new work or lost production funds: packets=%d held=%d err=%v", packets, held, err)
			}
		})
	}
}

func TestDelegatePostingCredentialStaysBoundToExistingOrder(t *testing.T) {
	f := newDelegateSyncFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("refused credential must not reach Seller") })
	f.order(t, "P1", "ready", "", false)
	targets, err := f.repo.SyncTargets(f.ctx, f.org)
	if err != nil || len(targets) != 1 {
		t.Fatalf("targets=%+v err=%v", targets, err)
	}
	var foreign int64
	if err := f.fixture.QueryRow(f.ctx, `SELECT id FROM organizations WHERE owner_user_id=96312`).Scan(&foreign); err != nil {
		t.Fatal(err)
	}
	if _, err := f.api.ReadPosting(f.ctx, delegatesvc.Actor{OrgID: foreign, UserID: 96312}, targets[0]); err == nil {
		t.Fatal("read another workspace's order credential")
	}
	for _, change := range []string{"order", "store", "posting", "expired key", "stale key", "broken key"} {
		target := targets[0]
		switch change {
		case "order":
			target.OrderID = uuid.NewString()
		case "store":
			target.StoreID = uuid.NewString()
		case "posting":
			target.PostingNumber = "different"
		case "expired key":
			_, err = f.fixture.Exec(f.ctx, `UPDATE store_seller_credentials SET key_expires_at_ms=1 WHERE org_id=$1`, f.org)
		case "stale key":
			_, err = f.fixture.Exec(f.ctx, `WITH cleared AS (UPDATE store_seller_credentials SET key_expires_at_ms=NULL WHERE org_id=$1 RETURNING store_id) UPDATE organization_stores SET credential_revision=2 WHERE org_id=$1`, f.org)
		case "broken key":
			_, err = f.fixture.Exec(f.ctx, `WITH revised AS (UPDATE organization_stores SET credential_revision=1 WHERE org_id=$1 RETURNING id) UPDATE store_seller_credentials SET ciphertext=decode(repeat('00',17),'hex') WHERE org_id=$1`, f.org)
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.api.ReadPosting(f.ctx, delegatesvc.Actor{OrgID: f.org, UserID: 96311}, target); err == nil {
			t.Fatalf("accepted %s identity/credential mismatch", change)
		}
	}
}
