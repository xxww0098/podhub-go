package scans

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/listing/submit"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestAcceptedTaskReadbackPersistsReceiptsIssuesAndNextDue(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	dsn, cleanup, err := testkit.StartPostgres(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO account_users(id,public_id,email,password_hash,role,name,target,supplier_id,plan,created_at,updated_at) VALUES(1,'accepted-reader-test','accepted@example.invalid','x','user','Test','/workspace','','lite',clock_timestamp(),clock_timestamp())`); err != nil {
		t.Fatal(err)
	}
	var org int64
	if err := pool.QueryRow(ctx, `INSERT INTO organizations(owner_user_id,name,plan,created_at,updated_at) VALUES(1,'Test','lite',clock_timestamp(),clock_timestamp()) RETURNING id`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	store, card := uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO organization_stores(org_id,uuid,create_order,name) VALUES($1,$2::uuid,1,'Test')`, org, store); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO listing_cards(id,org_id,payload) VALUES($1::uuid,$2,'{}')`, card, org); err != nil {
		t.Fatal(err)
	}
	seed := func(offer, task string, images ...string) string {
		row, intent := uuid.NewString(), uuid.NewString()
		if _, err := pool.Exec(ctx, `INSERT INTO listing_rows(id,org_id,card_id,store_id) VALUES($1::uuid,$2,$3::uuid,$4::uuid)`, row, org, card, store); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO submission_intents(id,org_id,store_id,listing_row_id,row_revision,client_operation_id,request_hash,state,offer_id,card_id,external_task_id,reconcile_after,slice_image_urls) VALUES($1::uuid,$2,$3::uuid,$4::uuid,1,$5,'hash','accepted',$6,$7::uuid,$8,clock_timestamp()-interval '1 second',COALESCE($9::text[],'{}'))`, intent, org, store, row, intent, offer, card, task, images); err != nil {
			t.Fatal(err)
		}
		return intent
	}
	claim := func() []acceptedRow {
		rows, err := claimAccepted(ctx, pool, 1)
		if err != nil || len(rows) != 1 {
			t.Fatalf("claim count=%d err=%v", len(rows), err)
		}
		return rows
	}
	intent := seed("a", "71")
	rows := claim()
	reader := &acceptedReader{task: `{"result":{"items":[{"offer_id":"a","product_id":7,"status":"pending","errors":[]}]}}`}
	if err := applyAccepted(ctx, pool, org, rows, observeAccepted(ctx, reader, rows)); err != nil {
		t.Fatal(err)
	}
	var state string
	var due *time.Time
	var outcome, issues []byte
	var code *string
	read := func(id string) {
		if err := pool.QueryRow(ctx, `SELECT state,reconcile_after,reconciliation_outcome,submission_issues,last_error_code FROM submission_intents WHERE id=$1::uuid`, id).Scan(&state, &due, &outcome, &issues, &code); err != nil {
			t.Fatal(err)
		}
	}
	read(intent)
	var observed struct {
		ImportTask importTaskItem `json:"importTask"`
		Found      submit.Found   `json:"found"`
		Probe      struct {
			Kind string `json:"kind"`
		} `json:"probe"`
	}
	if err := json.Unmarshal(outcome, &observed); err != nil {
		t.Fatal(err)
	}
	if state != "accepted" || due == nil || observed.ImportTask.Status != "pending" || string(issues) != "[]" {
		t.Fatalf("pending state=%s due=%v outcome=%s issues=%s", state, due, outcome, issues)
	}
	// Eight historical issues are a legal stored state. A newly read terminal
	// failure must fit the existing bound without losing the newest evidence.
	history := make([]map[string]any, 8)
	for i := range history {
		history[i] = map[string]any{"code": fmt.Sprintf("prior-%d", i), "createdAtMs": i}
	}
	rawHistory, err := json.Marshal(history)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE submission_intents SET reconcile_after=clock_timestamp()-interval '1 second',submission_issues=$2::jsonb WHERE id=$1::uuid`, intent, rawHistory); err != nil {
		t.Fatal(err)
	}
	rows = claim()
	reader.task = `{"result":{"items":[{"offer_id":"a","product_id":7,"status":"imported","errors":[{"level":"error","code":"SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT","message":"Duplicate product"}]}]}}`
	if err := applyAccepted(ctx, pool, org, rows, observeAccepted(ctx, reader, rows)); err != nil {
		t.Fatal(err)
	}
	read(intent)
	var issueList []map[string]any
	_ = json.Unmarshal(issues, &issueList)
	if err := json.Unmarshal(outcome, &observed); err != nil {
		t.Fatal(err)
	}
	if state != "accepted" || due != nil || code == nil || *code != submit.CodeRowRejected || len(issueList) != 8 {
		t.Fatalf("failed receipt state=%s due=%v code=%v issues=%s", state, due, code, issues)
	}
	for i, issue := range issueList[:7] {
		if issue["code"] != fmt.Sprintf("prior-%d", i+1) {
			t.Fatalf("newest seven issues were reordered or lost: %s", issues)
		}
	}
	if issueList[7]["code"] != submit.CodeRowRejected || issueList[7]["inputRevision"] != float64(1) {
		t.Fatalf("terminal failure lost its current input evidence: %s", issues)
	}
	if summary, _ := issueList[7]["summary"].(string); !strings.Contains(summary, "SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT") {
		t.Fatalf("terminal failure dropped the provider reason: %s", issues)
	}
	if observed.Probe.Kind != "failed" {
		t.Fatalf("terminal failure probe kind=%q, want failed", observed.Probe.Kind)
	}
	confirmed := seed("b", "72")
	rows = claim()
	reader.task = `{"result":{"items":[{"offer_id":"b","product_id":9,"status":"imported","errors":[{"level":"warning","message":"Information"}]}]}}`
	reader.info = `{"items":[{"id":9,"offer_id":"b","sources":[{"sku":10}]}]}`
	hits := observeAccepted(ctx, reader, rows)
	if _, err := pool.Exec(ctx, `UPDATE submission_intents SET reconcile_claim_until=clock_timestamp()+interval '2 minutes' WHERE id=$1::uuid`, confirmed); err != nil {
		t.Fatal(err)
	}
	if err := applyAccepted(ctx, pool, org, rows, hits); err != nil {
		t.Fatal(err)
	}
	read(confirmed)
	if due == nil || (len(outcome) > 0 && string(outcome) != "{}" && string(outcome) != "null") {
		t.Fatalf("stale claim applied receipt: %s", outcome)
	}
	if _, err := pool.Exec(ctx, `UPDATE submission_intents SET reconcile_claim_until=NULL,reconcile_after=clock_timestamp()-interval '1 second' WHERE id=$1::uuid`, confirmed); err != nil {
		t.Fatal(err)
	}
	rows = claim()
	if err := applyAccepted(ctx, pool, org, rows, observeAccepted(ctx, reader, rows)); err != nil {
		t.Fatal(err)
	}
	read(confirmed)
	if err := json.Unmarshal(outcome, &observed); err != nil {
		t.Fatal(err)
	}
	if state != "accepted" || due != nil || code != nil || string(issues) != "[]" || observed.ImportTask.Status != "imported" || observed.Found.ProductID != 9 {
		t.Fatalf("confirmed state=%s due=%v code=%v outcome=%s issues=%s", state, due, code, outcome, issues)
	}

	// Ozon can confirm the product before it publishes the SKU. Keep the
	// accepted scan due, then persist the identifiers once they appear.
	pending := seed("d", "74")
	reader.task = `{"result":{"items":[{"offer_id":"d","product_id":12,"status":"imported","errors":[]}]}}`
	reader.info = `{"items":[{"id":12,"offer_id":"d","sources":[{"sku":0}]}]}`
	rows = claim()
	if err := applyAccepted(ctx, pool, org, rows, observeAccepted(ctx, reader, rows)); err != nil {
		t.Fatal(err)
	}
	read(pending)
	if err := json.Unmarshal(outcome, &observed); err != nil {
		t.Fatal(err)
	}
	if state != "accepted" || due == nil || observed.Probe.Kind != "retry" || observed.Found.ProductID != 12 || observed.Found.SKU != 0 {
		t.Fatalf("sku pending state=%s due=%v outcome=%s", state, due, outcome)
	}
	reader.info = `{"items":[{"id":12,"offer_id":"d","sources":[{"sku":13}]}]}`
	if _, err := pool.Exec(ctx, `UPDATE submission_intents SET reconcile_after=clock_timestamp()-interval '1 second',reconcile_claim_until=NULL WHERE id=$1::uuid`, pending); err != nil {
		t.Fatal(err)
	}
	rows = claim()
	if err := applyAccepted(ctx, pool, org, rows, observeAccepted(ctx, reader, rows)); err != nil {
		t.Fatal(err)
	}
	read(pending)
	if err := json.Unmarshal(outcome, &observed); err != nil {
		t.Fatal(err)
	}
	if state != "accepted" || due != nil || observed.Probe.Kind != "accept" || observed.Found.SKU != 13 {
		t.Fatalf("sku confirmed state=%s due=%v outcome=%s", state, due, outcome)
	}

	// A second agreeing absence stops an accepted receipt scan instead of
	// holding the row under a 15s probe forever.
	absent := seed("c", "73")
	reader.task = `{"result":{"items":[{"offer_id":"c","product_id":11,"status":"imported","errors":[]}]}}`
	reader.info = `{"items":[]}`
	if _, err := pool.Exec(ctx, `UPDATE submission_intents SET reconciliation_outcome='{"probe":{"passes":1,"observation":"absent"}}' WHERE id=$1::uuid`, absent); err != nil {
		t.Fatal(err)
	}
	rows = claim()
	if err := applyAccepted(ctx, pool, org, rows, observeAccepted(ctx, reader, rows)); err != nil {
		t.Fatal(err)
	}
	read(absent)
	var stopped struct {
		Probe struct {
			Kind string `json:"kind"`
		} `json:"probe"`
	}
	if err := json.Unmarshal(outcome, &stopped); err != nil {
		t.Fatal(err)
	}
	if state != "accepted" || due != nil || stopped.Probe.Kind != "stop" {
		t.Fatalf("absent state=%s due=%v outcome=%s", state, due, outcome)
	}

	var workspace string
	if err := pool.QueryRow(ctx, `SELECT uuid::text FROM organizations WHERE id=$1`, org).Scan(&workspace); err != nil {
		t.Fatal(err)
	}
	key := "podhub-slices/" + uuid.NewString() + "/uploads/2026-11-01/1793491200000-" + uuid.NewString() + "/" + strings.Repeat("a", 64) + ".png"
	imageURL := "https://slices.example/" + key
	if _, err := pool.Exec(ctx, `INSERT INTO media_object_leases(workspace_uuid,batch_id,content_hash,org_id,object_key,media_account_id,
 first_seen_at,last_hit_at,expires_at,verification_status,public_ready_at,public_url)
 VALUES($1::uuid,$2,$3,$4,$5,'slice-test',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '4 hours','verified',clock_timestamp(),$6)`, workspace, uuid.NewString(), strings.Repeat("a", 64), org, key, imageURL); err != nil {
		t.Fatal(err)
	}
	photos := seed("photos", "75", imageURL)
	reader.task = `{"result":{"items":[{"offer_id":"photos","product_id":14,"status":"imported","errors":[]}]}}`
	reader.info = `{"items":[{"id":14,"offer_id":"photos","sources":[{"sku":15}]}]}`
	rows = claim()
	if err := applyAccepted(ctx, pool, org, rows, observeAccepted(ctx, reader, rows)); err != nil {
		t.Fatal(err)
	}
	read(photos)
	var fetched *time.Time
	if err := pool.QueryRow(ctx, `SELECT slice_images_fetched_at FROM submission_intents WHERE id=$1::uuid`, photos).Scan(&fetched); err != nil || fetched != nil || due == nil {
		t.Fatalf("product existence released source images: fetched=%v due=%v err=%v", fetched, due, err)
	}
	reader.pictures = fmt.Sprintf(`{"items":[{"product_id":14,"primary_photo":[%q],"errors":[]}]}`, imageURL)
	if _, err := pool.Exec(ctx, `UPDATE submission_intents SET reconcile_after=clock_timestamp()-interval '1 second' WHERE id=$1::uuid`, photos); err != nil {
		t.Fatal(err)
	}
	rows = claim()
	hits = observeAccepted(ctx, reader, rows)
	if _, err := pool.Exec(ctx, `UPDATE submission_intents SET reconcile_claim_until=clock_timestamp()+interval '2 minutes' WHERE id=$1::uuid`, photos); err != nil {
		t.Fatal(err)
	}
	if err := applyAccepted(ctx, pool, org, rows, hits); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT slice_images_fetched_at FROM submission_intents WHERE id=$1::uuid`, photos).Scan(&fetched); err != nil || fetched != nil {
		t.Fatalf("stale image claim committed: %v %v", fetched, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE submission_intents SET reconcile_claim_until=NULL,reconcile_after=clock_timestamp()-interval '1 second' WHERE id=$1::uuid`, photos); err != nil {
		t.Fatal(err)
	}
	rows = claim()
	if err := applyAccepted(ctx, pool, org, rows, observeAccepted(ctx, reader, rows)); err != nil {
		t.Fatal(err)
	}
	read(photos)
	if err := pool.QueryRow(ctx, `SELECT slice_images_fetched_at FROM submission_intents WHERE id=$1::uuid`, photos).Scan(&fetched); err != nil || fetched == nil || due != nil || !strings.Contains(string(outcome), "slicePictures") {
		t.Fatalf("image receipt not persisted: fetched=%v due=%v outcome=%s err=%v", fetched, due, outcome, err)
	}
}

func TestAcceptedFailureSummaryNamesTheProviderReason(t *testing.T) {
	currency := acceptedFailureSummary(&importTaskItem{failureCode: "currency_differs_from_contract"})
	if !strings.Contains(currency, "合同币种") || strings.Contains(currency, "currency_differs_from_contract") {
		t.Fatalf("currency failure summary=%q", currency)
	}
	other := acceptedFailureSummary(&importTaskItem{failureCode: "SOME_OTHER_CODE"})
	if !strings.Contains(other, "SOME_OTHER_CODE") {
		t.Fatalf("unknown provider code was dropped: %q", other)
	}
	if generic := acceptedFailureSummary(nil); strings.Contains(generic, "（") {
		t.Fatalf("codeless failure invented a provider reason: %q", generic)
	}
	long := providerCode(" " + strings.Repeat("x", providerCodeLimit+10) + " ")
	if len(long) != providerCodeLimit {
		t.Fatalf("provider code length=%d, want %d", len(long), providerCodeLimit)
	}
}
