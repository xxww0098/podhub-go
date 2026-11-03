package submit

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
	queue "github.com/xxww0098/podhub-go/internal/queue/contract"
	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
	sellerdomain "github.com/xxww0098/podhub-go/internal/seller/ozon/domain"
	storedomain "github.com/xxww0098/podhub-go/internal/store/domain"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
)

type refusedStoreTransport struct{ binds, writes int }

func (tr *refusedStoreTransport) WritesDisabled() bool        { return false }
func (tr *refusedStoreTransport) Ready(context.Context) error { return nil }
func (tr *refusedStoreTransport) Read(context.Context, string, []byte) (int, string, error) {
	return 0, "", ErrNotSent
}
func (tr *refusedStoreTransport) Write(context.Context, string, []byte) (int, string, error) {
	tr.writes++
	return 200, `{"task_id":1}`, nil
}
func (tr *refusedStoreTransport) BindStore(context.Context, sellercontract.StoreBinding) (Transport, error) {
	tr.binds++
	return nil, ErrNotSent
}

type receivedStoreTransport struct{ refusedStoreTransport }

func (tr *receivedStoreTransport) BindStore(context.Context, sellercontract.StoreBinding) (Transport, error) {
	tr.binds++
	return tr, nil
}
func (tr *receivedStoreTransport) Write(context.Context, string, []byte) (int, string, error) {
	tr.writes++
	return 200, `{"result":{"task_id":71}}`, nil
}

func queuedTransportFixture(t *testing.T, user int64, count int) (storedRevisionFixture, []frozen, []DraftItem, queue.Claimed, int64) {
	t.Helper()
	f := newStoredRevisionFixture(t, user)
	ready := draftRows(t, f.ctx, f.pool, f.org, f.store, f.card, count)
	for i := range ready {
		ready[i].importBody = json.RawMessage(fmt.Sprintf(`{"items":[{"offer_id":%q}]}`, ready[i].offerID))
	}
	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.ctx)
	if err := tenant.EnterApp(f.ctx, tx, f.org); err != nil {
		t.Fatal(err)
	}
	views, err := testSubmit().enqueueDrafts(f.ctx, tx, f.org, f.user, f.store, ready, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	var job queue.Claimed
	if err := f.pool.QueryRow(f.ctx, `UPDATE jobs SET state='running',attempt=1,lease_owner='store-transport-test',lease_epoch=1,lease_until=clock_timestamp()+interval '10 minutes' WHERE org_id=$1 RETURNING id,org_id,kind,submitter_user_id,payload`, f.org).Scan(&job.ID, &job.OrgID, &job.Kind, &job.SubmitterUserID, &job.Payload); err != nil {
		t.Fatal(err)
	}
	job.Owner, job.Epoch, job.Attempt, job.MaxAttempts = "store-transport-test", 1, 1, 8
	if job.SubmitterUserID != f.user {
		t.Fatalf("formal enqueue lost actor: %d", job.SubmitterUserID)
	}
	var storePK int64
	if err := f.pool.QueryRow(f.ctx, `SELECT id FROM organization_stores WHERE org_id=$1 AND uuid=$2::uuid`, f.org, f.store).Scan(&storePK); err != nil {
		t.Fatal(err)
	}
	return f, ready, views, job, storePK
}

func TestStoreBindingRefusalSettlesUnsentBatchWithoutLeavingQueued(t *testing.T) {
	f, _, views, job, _ := queuedTransportFixture(t, 986231, 1)
	tr := &refusedStoreTransport{}
	if err := testSubmit().Work(f.ctx, f.pool, job, tr); err != nil {
		t.Fatal(err)
	}
	var state, code, jobState string
	if err := f.pool.QueryRow(f.ctx, `SELECT state,last_error_code FROM submission_intents WHERE id=$1::uuid`, views[0].Intent.ID).Scan(&state, &code); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT state FROM jobs WHERE id=$1`, job.ID).Scan(&jobState); err != nil {
		t.Fatal(err)
	}
	var writes int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM seller_upstream_writes WHERE org_id=$1`, f.org).Scan(&writes); err != nil {
		t.Fatal(err)
	}
	if state != Rejected || code != CodeEgressUnreachable || jobState != "failed" || writes != 0 || tr.writes != 0 || tr.binds != 1 {
		t.Fatalf("state=%s code=%s job=%s ledger=%d calls=%d binds=%d", state, code, jobState, writes, tr.writes, tr.binds)
	}
}

func TestMixedBatchRecoversDispatchedRowsWithoutResendingOrLeavingQueued(t *testing.T) {
	f, ready, views, job, storePK := queuedTransportFixture(t, 986232, 2)
	in := Attempt{OrgID: f.org, IntentID: views[1].Intent.ID, RowID: ready[1].rowID, RowRevision: 1, StorePK: storePK, OfferID: ready[1].offerID, RequestHash: ready[1].digest, Body: ready[1].importBody, Lease: job.Lease()}
	if err := testSubmit().beginSending(f.ctx, f.pool, in); err != nil {
		t.Fatal(err)
	}
	tr := &refusedStoreTransport{}
	if err := testSubmit().Work(f.ctx, f.pool, job, tr); err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{Rejected, Unknown} {
		var state string
		if err := f.pool.QueryRow(f.ctx, `SELECT state FROM submission_intents WHERE id=$1::uuid`, views[i].Intent.ID).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state != want {
			t.Fatalf("item %d state=%s want=%s", i, state, want)
		}
	}
	var jobState, writeState, occupancy string
	if err := f.pool.QueryRow(f.ctx, `SELECT state FROM jobs WHERE id=$1`, job.ID).Scan(&jobState); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT state FROM seller_upstream_writes WHERE org_id=$1`, f.org).Scan(&writeState); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT state FROM seller_resource_occupancies WHERE org_id=$1`, f.org).Scan(&occupancy); err != nil {
		t.Fatal(err)
	}
	if tr.binds != 0 || tr.writes != 0 || jobState != "succeeded" || writeState != "result_unknown" || occupancy != "held" {
		t.Fatalf("binds=%d calls=%d job=%s write=%s occupancy=%s", tr.binds, tr.writes, jobState, writeState, occupancy)
	}
}

func TestListingCredentialScopeUsesCanonicalAADAndSeparateReadAuthority(t *testing.T) {
	f, _, views, _, storePK := queuedTransportFixture(t, 986233, 1)
	ring := seal.Ring{Primary: seal.DeriveKEK("fictional-listing-transport-key")}
	repo := storerepo.New(f.pool, tenant.BeginApp).WithCredentialKey(ring, true, seal.DefaultSellerKeyID, nil)
	var member int64
	if err := f.pool.QueryRow(f.ctx, `SELECT id FROM organization_members WHERE org_id=$1 AND user_id=$2`, f.org, f.user).Scan(&member); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLOUD_INSTANCE_ID", "listing-credential-test")
	if _, err := writer.Bootstrap(f.ctx, f.pool.Begin, "entitlement", "listing-credential-test", "test fixture", time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if api := repo.WriteTx(f.ctx, f.org, f.user, "", func(ctx context.Context, tx storedomain.RosterTx) error {
		_, api := tx.RegisterCredential(ctx, f.org, storedomain.Actor{UserID: f.user, MembershipID: member, Role: "owner"}, f.store, "fixture-client", "fixture-api-key", 1, nil, nil)
		if api != nil {
			return api
		}
		return tx.Record(ctx, storedomain.AuditRow{Module: "store_credential", EntityType: "store", EntityID: f.store, Method: "POST", Path: "/api/workspaces/stores/{uuid}/credential", Action: "store_credential_registered", Message: map[string]any{"uuid": f.store}})
	}); api != nil {
		t.Fatalf("register failed: %#v", api)
	}
	if api := repo.WriteTx(f.ctx, f.org, f.user, "", func(ctx context.Context, tx storedomain.RosterTx) error {
		_, err := tx.RegisterCredential(ctx, f.org, storedomain.Actor{UserID: f.user, MembershipID: member, Role: "owner"}, f.store, "fixture-client", "fixture-api-key", 1, nil, nil)
		return err
	}); api == nil || api.Status != 409 {
		t.Fatalf("stale registration error was not propagated: %#v", api)
	}
	scope := sellercontract.StoreBinding{OrgID: f.org, UserID: f.user, StorePK: storePK, StoreUUID: f.store, IntentIDs: []string{views[0].Intent.ID}}
	open := func(scope sellercontract.StoreBinding) error {
		tx, err := tenant.BeginApp(f.ctx, f.pool.Begin, scope.OrgID)
		if err != nil {
			return err
		}
		defer tx.Rollback(f.ctx)
		cred, err := storerepo.OpenListingCredentialTx(f.ctx, tx, ring, seal.DefaultSellerKeyID, scope, time.Now())
		if err == nil && (cred.ClientID != "fixture-client" || cred.APIKey != "fixture-api-key") {
			return fmt.Errorf("wrong bound credential")
		}
		return err
	}
	if err := open(scope); err != nil {
		t.Fatal("canonical credential did not open", err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE organization_members SET role='member' WHERE id=$1`, member); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE organization_stores SET assignee_membership_id=$1 WHERE id=$2`, member, storePK); err != nil {
		t.Fatal(err)
	}
	if err := open(scope); err != nil {
		t.Fatal("assigned member was refused", err)
	}
	// Current schema admits only owner/manager/member. Simulate a future stored
	// read-only role inside a rolled-back transaction, without changing the schema.
	roleTx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer roleTx.Rollback(f.ctx)
	if _, err := roleTx.Exec(f.ctx, `ALTER TABLE organization_members DROP CONSTRAINT ck_organization_members_role`); err != nil {
		t.Fatal(err)
	}
	if err := tenant.EnterApp(f.ctx, roleTx, f.org); err != nil {
		t.Fatal(err)
	}
	for _, role := range []string{"viewer", "reviewer"} {
		if _, err := roleTx.Exec(f.ctx, `UPDATE organization_members SET role=$1 WHERE id=$2`, role, member); err != nil {
			t.Fatal(err)
		}
		if _, err := storerepo.OpenListingCredentialTx(f.ctx, roleTx, ring, seal.DefaultSellerKeyID, scope, time.Now()); err == nil {
			t.Fatalf("downgraded %s retained send authority", role)
		}
	}
	if _, err := roleTx.Exec(f.ctx, `UPDATE submission_intents SET state='unknown' WHERE id=$1::uuid`, scope.IntentIDs[0]); err != nil {
		t.Fatal(err)
	}
	readRole := scope
	readRole.ReadOnly = true
	readRole.UserID = 0
	if _, err := storerepo.OpenListingCredentialTx(f.ctx, roleTx, ring, seal.DefaultSellerKeyID, readRole, time.Now()); err != nil {
		t.Fatal("existing ledger read lost authority after downgrade", err)
	}
	if err := roleTx.Rollback(f.ctx); err != nil {
		t.Fatal(err)
	}
	bad := scope
	bad.UserID = 0
	if err := open(bad); err == nil {
		t.Fatal("missing send actor admitted")
	}
	bad = scope
	bad.StoreUUID = uuid.NewString()
	if err := open(bad); err == nil {
		t.Fatal("foreign store binding admitted")
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE organization_members SET manual_disabled=true WHERE id=$1`, member); err != nil {
		t.Fatal(err)
	}
	if err := open(scope); err == nil {
		t.Fatal("disabled submitter admitted for write")
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE submission_intents SET state='unknown' WHERE id=$1::uuid`, scope.IntentIDs[0]); err != nil {
		t.Fatal(err)
	}
	read := scope
	read.ReadOnly = true
	read.UserID = 0
	if err := open(read); err != nil {
		t.Fatal("existing read convergence wrongly depends on departed actor", err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE store_seller_credentials SET key_expires_at_ms=1 WHERE store_id=$1`, storePK); err != nil {
		t.Fatal(err)
	}
	if err := open(read); err == nil {
		t.Fatal("expired read credential admitted")
	}
}

func TestProbeInfoMalformedResponsesAreUnreadable(t *testing.T) {
	for _, body := range []string{`{}`, `null`, `{"items":null}`, `{"items":[{"id":0,"offer_id":"a"}]}`, `{"items":[{"id":1,"offer_id":"a"},{"id":2,"offer_id":"a"}]}`} {
		if _, ok := parseInfoList(200, body, nil, []string{"a"}); ok {
			t.Fatalf("invalid response admitted: %s", body)
		}
	}
	if _, ok := parseInfoList(200, `{"items":[]}`, nil, []string{"a"}); !ok {
		t.Fatal("explicit empty response rejected")
	}
	tr := &refusedStoreTransport{}
	sights := readStore(context.Background(), nil, tr, probeKey{org: 7, store: uuid.NewString()}, []claimedIntent{{ID: uuid.NewString(), OfferID: "a"}})
	for _, hit := range sights {
		if hit.Sight != SightUnreadable {
			t.Fatal("credential failure became absence")
		}
		action := DecideProbe(ProbeMemory{Passes: 1, Observation: "absent"}, hit.Sight, hit.Found)
		if action.Kind == "release" || action.Observation != "unreadable" {
			t.Fatal("credential failure advanced absence")
		}
	}
}

func TestPhysicalAccountOccupancySeparatesClientsAndIsSharedAcrossTenants(t *testing.T) {
	for i, client := range []string{"client-a", "client-b", "client-a"} {
		f, ready, views, job, storePK := queuedTransportFixture(t, 986240+int64(i), 1)
		if _, err := f.pool.Exec(f.ctx, `UPDATE submission_intents SET offer_id='same-offer' WHERE id=$1::uuid`, views[0].Intent.ID); err != nil {
			t.Fatal(err)
		}
		in := Attempt{OrgID: f.org, IntentID: views[0].Intent.ID, RowID: ready[0].rowID, RowRevision: 1, StorePK: storePK, OfferID: "same-offer", RequestHash: ready[0].digest, Body: ready[0].importBody, Lease: job.Lease(), PhysicalAccountKey: sellerdomain.PhysicalAccountKey(client)}
		err := testSubmit().beginSending(f.ctx, f.pool, in)
		if i < 2 && err != nil {
			t.Fatalf("distinct physical client %d collided: %v", i, err)
		}
		if i == 2 {
			if err == nil {
				t.Fatal("the same physical client escaped its cross-tenant offer lock")
			}
			var state string
			var writes int
			if err := f.pool.QueryRow(f.ctx, `SELECT state FROM submission_intents WHERE id=$1::uuid`, in.IntentID).Scan(&state); err != nil {
				t.Fatal(err)
			}
			if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM seller_upstream_writes WHERE org_id=$1`, f.org).Scan(&writes); err != nil {
				t.Fatal(err)
			}
			if state != Queued || writes != 0 {
				t.Fatal("failed occupancy admission leaked a dispatching write")
			}
		}
	}
}

func TestAcceptedReceiptSchedulesReadbackWithoutResending(t *testing.T) {
	f, _, views, job, _ := queuedTransportFixture(t, 986251, 1)
	tr := &receivedStoreTransport{}
	if err := testSubmit().Work(f.ctx, f.pool, job, tr); err != nil {
		t.Fatal(err)
	}
	var state string
	var due *time.Time
	if err := f.pool.QueryRow(f.ctx, `SELECT state,reconcile_after FROM submission_intents WHERE id=$1::uuid`, views[0].Intent.ID).Scan(&state, &due); err != nil {
		t.Fatal(err)
	}
	if state != Accepted || due == nil || !due.After(time.Now()) || tr.writes != 1 {
		t.Fatalf("state=%s due=%v writes=%d", state, due, tr.writes)
	}
	f, ready, views, job, storePK := queuedTransportFixture(t, 986252, 1)
	in := Attempt{OrgID: f.org, IntentID: views[0].Intent.ID, RowID: ready[0].rowID, RowRevision: 1, StorePK: storePK, OfferID: ready[0].offerID, RequestHash: ready[0].digest, Body: ready[0].importBody, Lease: job.Lease()}
	if err := testSubmit().beginSending(f.ctx, f.pool, in); err != nil {
		t.Fatal(err)
	}
	if err := commitTaskIDs(f.ctx, f.pool, f.org, []string{in.IntentID}, 71); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE jobs SET state='failed',lease_owner=NULL,lease_until=NULL WHERE id=$1`, job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE submission_intents SET updated_at=clock_timestamp()-interval '31 seconds' WHERE id=$1::uuid`, in.IntentID); err != nil {
		t.Fatal(err)
	}
	if n, err := recoverStuckSubmitting(f.ctx, f.pool, 16); err != nil || n != 1 {
		t.Fatalf("recovery count=%d err=%v", n, err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT state,reconcile_after FROM submission_intents WHERE id=$1::uuid`, in.IntentID).Scan(&state, &due); err != nil {
		t.Fatal(err)
	}
	if state != Accepted || due == nil || !due.After(time.Now()) || tr.writes != 1 {
		t.Fatal("recovered receipt did not schedule a read-only follow-up")
	}
}
