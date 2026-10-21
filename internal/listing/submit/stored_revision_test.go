package submit

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/listing/core/contract"
)

func TestSendStoredRejectsStalePinsAndEnqueuesCurrentRows(t *testing.T) {
	f := newStoredRevisionFixture(t, 96213)
	stale := f.row(t, 2, "newer-content")
	current := f.row(t, 1, "approved-content")
	mod := &storedRevisionModule{}
	f.bind(t, mod)
	before := f.projection(t, stale)
	req := f.request(t, []string{stale, current}, map[string]int64{stale: 1, current: 1})
	result, err := SendStored(f.ctx, f.pool, f.org, f.user, req, time.Now())
	if err != nil || len(result.Items) != 2 {
		t.Fatalf("batch result: %+v err=%v", result, err)
	}
	items := make(map[string]BatchItem)
	for _, item := range result.Items {
		items[item.RowID] = item
	}
	if item := items[stale]; item.Created || item.Intent != nil || item.Skipped != "revision_mismatch" {
		t.Errorf("newer content was submitted under an old click pin: %+v", item)
	}
	if item := items[current]; !item.Created || item.Intent == nil || item.Intent.RowRevision != 1 {
		t.Errorf("current row did not enqueue: %+v", item)
	}
	if got := f.projection(t, stale); got != before {
		t.Errorf("mismatched row projection changed: before=%+v after=%+v", before, got)
	}
	if len(mod.calls) != 1 || mod.calls[0] != current {
		t.Errorf("stale row reached the freeze module: calls=%v", mod.calls)
	}
	var intents, jobs, queued int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM submission_intents WHERE org_id = $1`, f.org).Scan(&intents); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*), COALESCE(sum(jsonb_array_length(payload->'intents')),0) FROM jobs WHERE org_id = $1`, f.org).Scan(&jobs, &queued); err != nil {
		t.Fatal(err)
	}
	if intents != 1 || jobs != 1 || queued != 1 {
		t.Errorf("mismatched row created work: intents=%d jobs=%d queued=%d", intents, jobs, queued)
	}
}

func TestSendStoredConcurrentEditRollsBackWholeBatch(t *testing.T) {
	f := newStoredRevisionFixture(t, 96214)
	replay := f.row(t, 1, "accepted-content")
	first := f.row(t, 1, "approved-first")
	changed := f.row(t, 1, "approved-last")
	seedIntent(t, f.ctx, f.pool, f.org, f.store, f.card, frozen{
		rowID: replay, revision: 1, clientOp: "op-" + replay + "-accepted-content",
		digest: "digest-" + replay + "-accepted-content", offerID: "offer-" + replay,
	}, Accepted, time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC))
	if _, err := f.pool.Exec(f.ctx, `UPDATE listing_rows SET submission_state = 'accepted' WHERE org_id = $1 AND id = $2::uuid`, f.org, replay); err != nil {
		t.Fatal(err)
	}
	mod := &storedRevisionModule{pauseRow: changed, entered: make(chan struct{}), release: make(chan struct{})}
	f.bind(t, mod)
	firstBefore, replayBefore := f.projection(t, first), f.projection(t, replay)
	req := f.request(t, []string{replay, first, changed}, map[string]int64{replay: 1, first: 1, changed: 1})
	ctx, cancel := context.WithCancel(f.ctx)
	var release sync.Once
	type response struct {
		data BatchData
		err  error
	}
	result := make(chan response, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		data, err := SendStored(ctx, f.pool, f.org, f.user, req, time.Now())
		result <- response{data: data, err: err}
	}()
	t.Cleanup(func() {
		cancel()
		release.Do(func() { close(mod.release) })
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("submit did not leave the freeze barrier")
		}
	})
	select {
	case <-mod.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("freeze did not reach the last row")
	}
	editCtx, editCancel := context.WithTimeout(f.ctx, 2*time.Second)
	defer editCancel()
	tag, err := f.pool.Exec(editCtx, `UPDATE listing_rows SET revision = revision + 1, payload = jsonb_set(payload, '{marker}', '"edited-after-read"'::jsonb), updated_at = clock_timestamp() WHERE org_id = $1 AND id = $2::uuid AND revision = 1`, f.org, changed)
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("concurrent edit must commit without changing row/store lock order: rows=%d err=%v", tag.RowsAffected(), err)
	}
	changedBefore := f.projection(t, changed)
	release.Do(func() { close(mod.release) })
	var got response
	select {
	case got = <-result:
	case <-time.After(3 * time.Second):
		t.Fatal("submit did not finish")
	}
	var status Status
	if !errors.As(got.err, &status) || status.Code != 409 || status.Kind != "revision_mismatch" || !strings.Contains(status.Message, "本批未入队") || !strings.Contains(status.Message, "刷新后重试") {
		t.Errorf("concurrent edit needs an explicit whole-batch refusal: data=%+v err=%v", got.data, got.err)
	}
	if len(got.data.Items) != 0 {
		t.Errorf("rolled-back transaction returned success items: %+v", got.data)
	}
	for _, item := range []struct {
		id     string
		before storedRowProjection
	}{{first, firstBefore}, {replay, replayBefore}, {changed, changedBefore}} {
		if after := f.projection(t, item.id); after != item.before {
			t.Errorf("rollback changed row %s: before=%+v after=%+v", item.id, item.before, after)
		}
	}
	var intents, jobs int
	var replayState string
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*), max(state) FROM submission_intents WHERE org_id = $1`, f.org).Scan(&intents, &replayState); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM jobs WHERE org_id = $1`, f.org).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if intents != 1 || replayState != Accepted || jobs != 0 {
		t.Errorf("whole batch did not roll back: intents=%d state=%s jobs=%d", intents, replayState, jobs)
	}
}

type storedRevisionFixture struct {
	pool        *pgxpool.Pool
	ctx         context.Context
	org, user   int64
	store, card string
}

func newStoredRevisionFixture(t *testing.T, userID int64) storedRevisionFixture {
	t.Helper()
	pool, ctx := draftParityDB(t)
	org, user := seedDraftOrg(t, ctx, pool, userID)
	store, card := uuid.NewString(), uuid.NewString()
	category := 100000 + userID
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM listing_cards WHERE org_id = $1`, org)
		purgeDraft(context.Background(), pool, org, user)
		_, _ = pool.Exec(context.Background(), `DELETE FROM ozon_catalog_schema_cache WHERE description_category_id = $1 AND type_id = $2`, category, userID)
	})
	if _, err := pool.Exec(ctx, `INSERT INTO listing_cards (id, org_id, payload) VALUES ($1::uuid, $2, $3::jsonb)`, card, org, fmt.Sprintf(`{"descriptionCategoryId":%d,"typeId":%d}`, category, userID)); err != nil {
		t.Fatal(err)
	}
	var compressed bytes.Buffer
	zw := gzip.NewWriter(&compressed)
	if _, err := zw.Write([]byte(`[]`)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO ozon_catalog_schema_cache (description_category_id, type_id, language, payload, fetched_at_ms, byte_size) VALUES ($1, $2, 'default', $3, $4, $5)`, category, userID, compressed.Bytes(), time.Now().UnixMilli(), compressed.Len()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO organization_stores(org_id,uuid,create_order,name) VALUES($1,$2::uuid,1,'Draft')`, org, store); err != nil {
		t.Fatal(err)
	}
	return storedRevisionFixture{pool: pool, ctx: ctx, org: org, user: user, store: store, card: card}
}

func (f storedRevisionFixture) row(t *testing.T, revision int64, marker string) string {
	t.Helper()
	id := uuid.NewString()
	payload := fmt.Sprintf(`{"schemaRevision":"workflow:sha256:test","draft":{"values":{}},"marker":%q}`, marker)
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO listing_rows (id, org_id, card_id, store_id, revision, payload, submission_state) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::jsonb, 'none')`, id, f.org, f.card, f.store, revision, payload); err != nil {
		t.Fatal(err)
	}
	return id
}

func (f storedRevisionFixture) request(t *testing.T, rows []string, pins map[string]int64) BatchBody {
	t.Helper()
	expected := make([]map[string]any, 0, len(pins))
	for _, id := range rows {
		expected = append(expected, map[string]any{"row_id": id, "revision": pins[id]})
	}
	raw, err := json.Marshal(map[string]any{"store_id": f.store, "row_ids": rows, "expected_revisions": expected})
	if err != nil {
		t.Fatal(err)
	}
	req, err := ParseBatch(raw)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func (f storedRevisionFixture) bind(t *testing.T, mod contract.Module) {
	t.Helper()
	previous := boundModule
	BindModule(mod)
	t.Cleanup(func() { BindModule(previous) })
}

type storedRowProjection struct {
	revision, view int64
	state, payload string
	updated        time.Time
}

func (f storedRevisionFixture) projection(t *testing.T, id string) storedRowProjection {
	t.Helper()
	var row storedRowProjection
	if err := f.pool.QueryRow(f.ctx, `SELECT revision, view_revision, submission_state, payload::text, updated_at FROM listing_rows WHERE org_id = $1 AND id = $2::uuid`, f.org, id).Scan(&row.revision, &row.view, &row.state, &row.payload, &row.updated); err != nil {
		t.Fatal(err)
	}
	return row
}

type storedRevisionModule struct {
	storedSubmitModule
	pauseRow         string
	entered, release chan struct{}
	calls            []string
}

func (m *storedRevisionModule) Call(ctx context.Context, op uint32, _, body []byte) ([]byte, error) {
	if op != contract.OpFreezeListing {
		return nil, fmt.Errorf("unexpected op %d", op)
	}
	var input struct {
		RowID string `json:"rowId"`
		Row   struct {
			Marker string `json:"marker"`
		} `json:"row"`
	}
	if err := json.Unmarshal(body, &input); err != nil {
		return nil, err
	}
	m.calls = append(m.calls, input.RowID)
	if input.RowID == m.pauseRow {
		close(m.entered)
		select {
		case <-m.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return json.Marshal(map[string]any{
		"status": "frozen", "digest": "digest-" + input.RowID + "-" + input.Row.Marker,
		"clientOperationId": "op-" + input.RowID + "-" + input.Row.Marker, "offerId": "offer-" + input.RowID,
		"import": map[string]any{"items": []map[string]string{{"offer_id": "offer-" + input.RowID, "name": input.Row.Marker}}},
	})
}
