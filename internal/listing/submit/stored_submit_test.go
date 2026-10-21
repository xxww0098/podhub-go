package submit

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/xxww0098/podhub-go/internal/listing/core/contract"
)

func TestSendStoredKeepsReplayStateAndCardOwnership(t *testing.T) {
	pool, ctx := draftParityDB(t)
	orgID, userID := seedDraftOrg(t, ctx, pool, 96212)
	storeID := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO organization_stores(org_id,uuid,create_order,name) VALUES($1,$2::uuid,1,'Draft')`, orgID, storeID); err != nil {
		t.Fatal(err)
	}
	cards := []string{uuid.NewString(), uuid.NewString()}
	const category, typeID = 196212, 96212
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM listing_cards WHERE org_id = $1`, orgID)
		purgeDraft(context.Background(), pool, orgID, userID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM ozon_catalog_schema_cache WHERE description_category_id = $1 AND type_id = $2`, category, typeID)
	})
	for _, cardID := range cards {
		_, err := pool.Exec(ctx, `
			INSERT INTO listing_cards (id, org_id, payload)
			VALUES ($1::uuid, $2, $3::jsonb)`, cardID, orgID,
			fmt.Sprintf(`{"descriptionCategoryId":%d,"typeId":%d}`, category, typeID))
		if err != nil {
			t.Fatal(err)
		}
	}
	var compressed bytes.Buffer
	zw := gzip.NewWriter(&compressed)
	if _, err := zw.Write([]byte(`[]`)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	_, err := pool.Exec(ctx, `
		INSERT INTO ozon_catalog_schema_cache (description_category_id, type_id, language, payload, fetched_at_ms, byte_size)
		VALUES ($1, $2, 'default', $3, $4, $5)`, category, typeID, compressed.Bytes(), now.UnixMilli(), compressed.Len())
	if err != nil {
		t.Fatal(err)
	}
	previousModule := boundModule
	BindModule(storedSubmitModule{})
	t.Cleanup(func() { BindModule(previousModule) })

	states := []string{"none", "none", Queued, Submitting, Unknown, Accepted, Rejected, Cancelled}
	rowIDs := make([]string, len(states))
	rowCards := make([]string, len(states))
	rowUpdatedBefore := make([]time.Time, len(states))
	rowViewBefore := make([]int64, len(states))
	stableTime := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	for i, state := range states {
		rowID, cardID := uuid.NewString(), cards[i%len(cards)]
		rowIDs[i], rowCards[i] = rowID, cardID
		_, err := pool.Exec(ctx, `
			INSERT INTO listing_rows (id, org_id, card_id, store_id, payload, submission_state, updated_at)
			VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::jsonb, $6, $7)`,
			rowID, orgID, cardID, storeID, `{"schemaRevision":"workflow:sha256:test","draft":{"values":{}}}`, state, stableTime)
		if err != nil {
			t.Fatal(err)
		}
		if state != "none" {
			seedIntent(t, ctx, pool, orgID, storeID, cardID, frozen{
				rowID: rowID, revision: 1, clientOp: "op-" + rowID,
				digest: "digest-" + rowID, offerID: "offer-" + rowID,
			}, state, stableTime)
		}
		// Inserting an intent deliberately touches the row projection through
		// a database trigger. The replay must preserve that resulting version.
		if err := pool.QueryRow(ctx, `SELECT updated_at, view_revision FROM listing_rows WHERE id = $1::uuid`, rowID).
			Scan(&rowUpdatedBefore[i], &rowViewBefore[i]); err != nil {
			t.Fatal(err)
		}
	}

	pins := make(map[string]int64, len(rowIDs))
	for _, id := range rowIDs {
		pins[id] = 1
	}
	result, err := SendStored(ctx, pool, orgID, userID, BatchBody{StoreID: storeID, RowIDs: rowIDs, ExpectedRevisions: pins}, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != len(states) {
		t.Fatalf("results: %+v", result.Items)
	}
	for i, item := range result.Items {
		wantState := states[i]
		created := wantState == "none"
		if created {
			wantState = Queued
		}
		if item.RowID != rowIDs[i] || item.Created != created || item.Intent == nil || item.Intent.State != wantState {
			t.Errorf("row %d response: %+v", i, item)
			continue
		}
		var intentState, rowState, intentCard string
		var rowUpdated time.Time
		var rowView int64
		err := pool.QueryRow(ctx, `
			SELECT i.state, i.card_id::text, r.submission_state, r.updated_at, r.view_revision
			  FROM submission_intents i JOIN listing_rows r ON r.id = i.listing_row_id
			 WHERE i.id = $1::uuid`, item.Intent.ID).Scan(&intentState, &intentCard, &rowState, &rowUpdated, &rowView)
		if err != nil {
			t.Fatal(err)
		}
		if intentState != wantState || rowState != wantState {
			t.Errorf("row %d replay changed state: intent=%s row=%s want=%s", i, intentState, rowState, wantState)
		}
		if intentCard != rowCards[i] {
			t.Errorf("row %d belongs to card %s, stored intent references %s", i, rowCards[i], intentCard)
		}
		if !created && (!rowUpdated.Equal(rowUpdatedBefore[i]) || rowView != rowViewBefore[i]) {
			t.Errorf("row %d replay rewrote its projection: time=%s (was %s), view=%d (was %d)", i, rowUpdated, rowUpdatedBefore[i], rowView, rowViewBefore[i])
		}
	}
	var intentCount, jobCount, queuedItems int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM submission_intents WHERE org_id = $1`, orgID).Scan(&intentCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(sum(jsonb_array_length(payload->'intents')), 0)
		  FROM jobs WHERE org_id = $1 AND kind = 'listing.submit.batch'`, orgID).Scan(&jobCount, &queuedItems); err != nil {
		t.Fatal(err)
	}
	if intentCount != len(states) || jobCount != 1 || queuedItems != 2 {
		t.Fatalf("replays created work: intents=%d jobs=%d queued items=%d", intentCount, jobCount, queuedItems)
	}
}

// Freezing is a separate WASM contract; this fixture isolates persistence of
// deterministic frozen rows so replay and cross-card batches are testable.
type storedSubmitModule struct{}

func (storedSubmitModule) Call(_ context.Context, op uint32, _, body []byte) ([]byte, error) {
	if op != contract.OpFreezeListing {
		return nil, fmt.Errorf("unexpected op %d", op)
	}
	var input struct {
		RowID string `json:"rowId"`
	}
	if err := json.Unmarshal(body, &input); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{
		"status": "frozen", "digest": "digest-" + input.RowID,
		"clientOperationId": "op-" + input.RowID, "offerId": "offer-" + input.RowID,
		"import": map[string]any{"items": []map[string]string{{"offer_id": "offer-" + input.RowID}}},
	})
}

func (storedSubmitModule) Snapshot(context.Context, []byte) ([]byte, error) {
	return []byte(`{"schema_revision":"workflow:sha256:test","fields":[]}`), nil
}

func (storedSubmitModule) LegacyRevision(context.Context, []byte) (string, error) {
	return "workflow:sha256:test", nil
}
